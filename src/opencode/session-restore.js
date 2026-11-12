// SPDX-License-Identifier: Apache-2.0
// Boot-time session restore for the OpenCode surface.
//
// Why: journals persist every conversation, and the engine re-opens a durable
// journal by id on its own (`restoreDurableEngine`). What the surface lacked
// was durable wire identity — `attachSession` minted a fresh `session_*` and
// `ses_*` per process, so a restart lost the GUI's history. This module walks
// the session index (plus discovery of pre-index journals), re-attaches each
// session through the ordinary create path so the engine replays its journal,
// and seeds the v2 projection with the transcript the replay produced.
//
// Fail-closed: one broken session never blocks startup — it is skipped with a
// logged reason, and the surface serves the sessions that did restore.
import { discoverUnindexedSessions, readSessionIndex } from './session-index.js';
import { tokenView, contextFillView } from './wire-transcript.js';
import { toolSummary, toolDisplayOutput } from './tool-summary.js';
import { presentedToolTarget } from '../engine/records.js';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_RESTORE_SESSIONS = 128;
const MAX_SEED_RECORDS = 20_000;

export async function restorePersistedSessions(workspace, options) {
  const storeRoot = options.storeRoot;
  if (!storeRoot) return { restored: [], skipped: [] };
  const skipped = [];
  let index = [];
  try { index = await readSessionIndex(storeRoot); }
  catch (error) { skipped.push({ sessionId: null, code: error.code ?? 'index_unreadable' }); }
  let discovered = [];
  try {
    discovered = await discoverUnindexedSessions(storeRoot, index.map((entry) => entry.sessionId));
  } catch (error) { skipped.push({ sessionId: null, code: error.code ?? 'discovery_failed' }); }
  const candidates = [...index.map((entry) => ({
    ocId: entry.ocId, sessionId: entry.sessionId, title: entry.title ?? 'Restored session',
    directory: entry.directory ?? '', createdAt: entry.createdAt ?? null, parentID: entry.parentID ?? null,
  })), ...discovered.map((entry) => ({
    ocId: null, sessionId: entry.sessionId, title: 'Restored session',
    directory: entry.workspaceRoot ?? '', createdAt: entry.createdAt ?? null, parentID: null,
  }))].slice(0, MAX_RESTORE_SESSIONS);
  const restored = [];
  for (const candidate of candidates) {
    try {
      // Why the journal check: an index entry can name a journal that no longer
      // exists (deleted store, pruned retention, hand-editing). Without this
      // guard the engine would silently create a fresh empty conversation
      // instead of restoring, and the operator would see a resurrected blank.
      await stat(join(storeRoot, `${candidate.sessionId}.journal.ndjson`));
      const described = await workspace.operations.restore({
        ocId: candidate.ocId, engineSessionId: candidate.sessionId, title: candidate.title,
        directory: candidate.directory, createdAt: candidate.createdAt, parentID: candidate.parentID,
      });
      if (described) {
        restored.push(described);
        options.logger?.record({ type: 'opencode_session_restored', ocId: described.id, sessionId: candidate.sessionId });
      }
    } catch (error) {
      // Why a live lock is distinct: another process still owns the journal, so
      // the session is not lost — it is simply served by whoever owns it.
      const code = error.code ?? 'restore_failed';
      skipped.push({ sessionId: candidate.sessionId, ocId: candidate.ocId ?? null, code });
      options.logger?.record({ type: 'opencode_session_restore_skipped',
        sessionId: candidate.sessionId, ocId: candidate.ocId ?? null, code });
    }
  }
  return { restored, skipped };
}

/** Seed the v2 projection and the wire ledger from the engine's replayed journal.
 *
 *  Why from the engine transcript: `restoreDurableEngine` already applied the
 *  effective revert timeline to `engine.transcript`, so seeding from it shows
 *  the operator exactly the visible history the engine would answer from —
 *  hidden turns stay hidden, consistent with the session record.
 *
 *  Why outcomes come from `latestTurnOutcome` plus journal records: the
 *  transcript intentionally omits outcome records (they are control state, not
 *  context), so each turn's answer text, finish, and usage arrive from the
 *  engine's restored records joined by turn id.
 *
 *  Security: tool rows carry name, state, and a bounded guidance message only;
 *  arguments and raw results stay with the engine, the same as live turns. */
export function seedSessionHistory(session, workspace) {
  const engine = session.engine;
  const transcript = Array.isArray(engine?.transcript) ? engine.transcript : [];
  const outcomes = turnOutcomes(engine);
  const seeded = seedLedger(transcript.slice(-MAX_SEED_RECORDS), outcomes);
  seedWireLedger(session, seeded);
  seedProjection(workspace?.v2 ?? session.v2, session.ocId ?? session.id, seeded);
  return seeded;
}

/** The turn boundaries a restored engine holds. Why journal records and not
 *  only `latestTurnOutcome`: a multi-turn conversation restores every turn's
 *  boundary, and only the last one is the *latest*. */
function turnOutcomes(engine) {
  const outcomes = new Map();
  const restored = Array.isArray(engine?.restoredJournalRecords) ? engine.restoredJournalRecords : [];
  for (const record of restored) {
    if (record?.type === 'turn_outcome') {
      const turnId = record.payload?.turn_id ?? record.payload?.turnId;
      if (typeof turnId === 'string') outcomes.set(turnId, record.payload);
    }
  }
  const latest = engine?.latestTurnOutcome;
  if (latest && typeof latest.turn_id === 'string') outcomes.set(latest.turn_id, latest);
  return outcomes;
}

/** One call row, with the arrival ordinal the seed interleaves by and the
 *  journal's redacted target, so a restored row reads like a live one. */
function restoreToolRequest(current, record) {
  const key = record.requestId ?? record.providerCallId ?? record.toolName;
  if (typeof record.toolName !== 'string' || !record.toolName || current.tools.has(key)) return;
  const target = presentedToolTarget(record.toolName, record.args);
  current.tools.set(key, { type: 'tool', id: key, name: record.toolName, order: current.nextOrder ?? 0,
    time: { created: Date.now() },
    state: { status: 'running', input: target ? { target } : {}, metadata: {} } });
  current.nextOrder = (current.nextOrder ?? 0) + 1;
}

/** A settled row: outcome summary and the display excerpt, as a live turn publishes. */
function restoreToolResult(current, record) {
  const part = current.tools.get(record.requestId ?? record.providerCallId);
  if (!part) return;
  const failed = record.toolLifecycleStatus !== 'succeeded';
  const summary = toolSummary({
    status: failed ? 'failed' : 'succeeded', elapsedMs: record.elapsedMs ?? null,
    failureReason: failed ? (record.reasonCode ?? null) : null,
  });
  const output = toolDisplayOutput(record.content);
  const metadata = { ...(summary.outcome ? { outcome: summary.outcome } : {}), ...(output ? { output } : {}) };
  part.state = failed
    ? { status: 'error', input: part.state.input, metadata,
      error: { type: 'nna_tool_failed',
        message: 'The tool did not complete. NNA records the reason in its own journal.' } }
    : { status: 'completed', input: part.state.input, metadata,
      content: [{ type: 'text', text: summary.outcome ?? '' }] };
}

function seedLedger(records, outcomes) {
  const turns = [];
  let current = null;
  let turnId = null;
  for (const record of records) {
    if (record?.type === 'message') {
      if (record.role === 'user') {
        if (current && current.text !== null) turns.push(current);
        turnId = typeof record.turnId === 'string' ? record.turnId : null;
        current = {
          userText: typeof record.content === 'string' ? record.content : '',
          text: null, requestId: typeof record.requestId === 'string' ? record.requestId : null,
          createdAt: record.createdAt ?? null, finish: null, tokens: null, tools: new Map(),
          userKey: randomUUID(), assistantKey: randomUUID(), idleKey: randomUUID(),
        };
      } else if (current && typeof record.content === 'string' && record.content.length > 0) {
        // Why a segment per record: the journal writes one assistant text per model
        // step, and a multi-step turn writes prose between its tool calls. Each
        // record carries an arrival ordinal, which is what the seed interleaves by.
        current.textSegments = current.textSegments ?? [];
        current.textSegments.push({ text: record.content, order: current.nextOrder ?? 0 });
        current.nextOrder = (current.nextOrder ?? 0) + 1;
        if (current.text === null) current.text = record.content;
      }
    } else if (record?.type === 'tool_request' && current) {
      restoreToolRequest(current, record);
    } else if (record?.type === 'tool_result' && current) {
      restoreToolResult(current, record);
    } else if (record?.type === 'turn_outcome' && current) {
      settleTurn(current, record.payload ?? record);
      turns.push(current);
      current = null;
    }
  }
  // Why the joined outcome: a restored transcript carries the turn's messages
  // but not its boundary record, so the outcome is looked up by turn id.
  if (current) {
    const outcome = turnId ? outcomes.get(turnId) : null;
    if (outcome) settleTurn(current, outcome);
    else if (current.text !== null) {
      current.finish = 'stop';
      current.tokens = { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
    }
    turns.push(current);
  }
  return turns;
}

function settleTurn(turn, outcome) {
  turn.text = typeof outcome.text === 'string' ? outcome.text : (turn.text ?? '');
  turn.finish = outcome.outcome === 'completed' ? 'stop'
    : outcome.outcome === 'cancelled' ? 'abort' : 'error';
  // Why the shared reader: a restored turn's token payload must carry the same
  // cache and reasoning evidence a live turn does, or the context meter renders
  // a different (wrong) pane after a restart than it did before one.
  // Why the step window first: a transcript meter reads the newest reply's total
  // as the current context fill; the cumulative usage bills every step's re-sent
  // prompt and overstates the fill. See contextFillView.
  turn.tokens = contextFillView(outcome ?? {});
  turn.completedAt = Date.now();
}

function seedWireLedger(session, turns) {
  const wire = session.wireSession;
  if (!wire || typeof wire.seedHistory !== 'function') return;
  wire.seedHistory(turns);
}

function seedProjection(v2, ocId, turns) {
  if (!v2 || typeof v2.seed !== 'function') return;
  v2.seed(ocId, turns);
}
