// SPDX-License-Identifier: Apache-2.0
import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readJournalPage, readJournalPrefix } from '../store.js';
import { ContractError } from '../ids.js';
import { toolLifecycleStatus, toolReviewOutcome } from './tool-result-contract.js';

const SESSION_ID = /^[A-Za-z0-9_-]{1,256}$/u;
const DEFAULT_SESSION_LIMIT = 20;
const MAX_SESSION_LIMIT = 64;
const MAX_SESSION_CANDIDATES = 512;
const SESSION_DIAGNOSTIC_RECORD_LIMIT = 256;
const TURN_DIAGNOSTIC_PAGE_LIMIT = 2_000;
const MAX_TURN_DIAGNOSTIC_RECORDS = 20_000;
const MAX_TURN_OFFSET = 31;
const MAX_AVAILABLE_TURNS = 32;

export function selfDiagnosticsDefinitions(contextProvider) {
  return [diagnoseTurnDefinition(contextProvider), listSessionsDefinition(contextProvider)];
}

function diagnoseTurnDefinition(contextProvider) {
  return {
    name: 'nna.diagnose_turn', version: 1,
    purpose: 'Inspect bounded, content-redacted lifecycle evidence for the active or an earlier NNA turn. Use turn_offset 1 for the previous turn.',
    sideEffect: 'read_only', scope: 'runtime_diagnostics', cancellation: true, timeoutMs: 10_000,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        selector: { type: 'string', enum: ['current', 'latest', 'latest_failed', 'list'], description: 'Select the current turn, latest session, latest failed session, or a bounded session list. Defaults to current.' },
        limit: { type: 'integer', minimum: 1, maximum: 64, description: 'Maximum sessions when selector is list. Defaults to 20.' },
        session_id: { type: 'string', minLength: 1, maxLength: 256, description: 'Optional exact durable session id. Do not combine with selector.' },
        turn_id: { type: 'string', minLength: 1, maxLength: 256, description: 'Optional turn id. Defaults to the active or latest turn in the selected session.' },
        turn_offset: { type: 'integer', minimum: 0, maximum: 31, description: 'Select a recent turn by position: 0 is current or latest, 1 is the previous turn, and larger values move further back. Do not combine with turn_id.' },
      },
    },
    validate: async (args) => {
      if (!hasOnlyKeys(args, ['selector', 'limit', 'session_id', 'turn_id', 'turn_offset'])
        || !optionalIdentifier(args.session_id) || !optionalIdentifier(args.turn_id)
        || (args.session_id !== undefined && !SESSION_ID.test(args.session_id))
        || (args.selector !== undefined && !['current', 'latest', 'latest_failed', 'list'].includes(args.selector))
        || (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_SESSION_LIMIT))
        || (args.turn_offset !== undefined && (!Number.isInteger(args.turn_offset)
          || args.turn_offset < 0 || args.turn_offset > MAX_TURN_OFFSET))
        || (args.session_id !== undefined && args.selector !== undefined)
        || (args.turn_id !== undefined && args.turn_offset !== undefined)
        || (args.turn_id !== undefined && args.selector === 'list')
        || (args.turn_offset !== undefined && args.selector === 'list')) {
        throw new ContractError('tool_schema_invalid', 'diagnostic selector, limit, session_id, turn_id, or turn_offset is invalid or conflicting');
      }
      return { args: {
        selector: args.selector ?? 'current', limit: args.limit ?? DEFAULT_SESSION_LIMIT,
        ...(args.session_id === undefined ? {} : { session_id: args.session_id }),
        ...(args.turn_id === undefined ? {} : { turn_id: args.turn_id }),
        ...(args.turn_offset === undefined ? {} : { turn_offset: args.turn_offset }),
      } };
    },
    executor: (request, signal) => executeTurnDiagnosis(contextProvider, request, signal),
  };
}

async function executeTurnDiagnosis(contextProvider, request, signal) {
  if (signal.aborted) throw new ContractError('tool_cancelled', 'tool was cancelled');
  const context = contextProvider?.();
  if (!context?.journalPath) throw new ContractError('diagnostics_unavailable', 'the current runtime has no readable durable journal');
  if (request.args.selector === 'list') {
    const sessions = await listDurableSessions(context, request.args.limit, signal);
    return { content: JSON.stringify({ schema: 'nna.session_catalog.v1', sessions }, null, 2), metadata: { sessions: sessions.length, redacted: true } };
  }
  let selectedSessionId = request.args.session_id;
  if (!selectedSessionId && ['latest', 'latest_failed'].includes(request.args.selector)) {
    const sessions = await listDurableSessions(context, MAX_SESSION_LIMIT, signal);
    const selected = request.args.selector === 'latest_failed'
      ? sessions.find((item) => item.latest_failure_code) : sessions[0];
    if (!selected) throw new ContractError('diagnostics_session_not_found', `no ${request.args.selector === 'latest_failed' ? 'failed ' : ''}durable session was found`);
    selectedSessionId = selected.session_id;
  }
  const sessionId = selectedSessionId ?? context.sessionId;
  const journalPath = selectedSessionId && selectedSessionId !== context.sessionId
    ? containedSessionJournalPath(context.sessionsRoot, selectedSessionId) : context.journalPath;
  const page = await readRecentDiagnosticRecords(journalPath, signal);
  const availableTurns = recentTurnCatalog(page.records);
  const turnId = request.args.turn_id
    ?? selectTurnByOffset(
      availableTurns,
      request.args.turn_offset ?? 0,
      sessionId === context.sessionId ? context.activeTurnId : null,
    );
  if (!turnId) throw new ContractError('diagnostics_turn_unavailable', 'no recent turn is available to diagnose');
  const records = page.records.filter((record) => recordTurnId(record) === turnId);
  if (records.length === 0) throw new ContractError(
    'diagnostics_turn_not_found',
    'the requested turn is outside the bounded recent journal window; inspect available_turns and choose a listed turn',
  );
  return {
    content: JSON.stringify({
      ...summarize(sessionId, turnId, records, sessionId === context.sessionId ? context.state : null),
      available_turns: availableTurns,
    }, null, 2),
    metadata: { session_id: sessionId, turn_id: turnId, records_examined: records.length, redacted: true, truncated_history: page.hasMore },
  };
}

function listSessionsDefinition(contextProvider) {
  return {
    name: 'nna.list_sessions', version: 1,
    purpose: 'List bounded recent durable NNA sessions so a different Console run can be selected for diagnosis.',
    sideEffect: 'read_only', scope: 'runtime_diagnostics', cancellation: true, timeoutMs: 10_000,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 64, description: 'Maximum recent durable sessions to return. Defaults to 20.' },
      },
    },
    validate: async (args) => {
      if (!hasOnlyKeys(args, ['limit'])
        || (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_SESSION_LIMIT))) {
        throw new ContractError('tool_schema_invalid', `limit must be an optional integer from 1 to ${MAX_SESSION_LIMIT}`);
      }
      return { args: { limit: args.limit ?? DEFAULT_SESSION_LIMIT } };
    },
    executor: async (request, signal) => {
      if (signal.aborted) throw new ContractError('tool_cancelled', 'tool was cancelled');
      const context = contextProvider?.();
      if (!context?.sessionsRoot) throw new ContractError('diagnostics_unavailable', 'the runtime session catalog is unavailable');
      const sessions = await listDurableSessions(context, request.args.limit, signal);
      return { content: JSON.stringify({ schema: 'nna.session_catalog.v1', sessions }, null, 2), metadata: { sessions: sessions.length, redacted: true } };
    },
  };
}

export async function listDurableSessions(context, limit = DEFAULT_SESSION_LIMIT, signal = null) {
  if (!context?.sessionsRoot) throw new ContractError('diagnostics_unavailable', 'the runtime session catalog is unavailable');
  const bounded = Number.isInteger(limit) ? Math.max(1, Math.min(MAX_SESSION_LIMIT, limit)) : DEFAULT_SESSION_LIMIT;
  let entries;
  try { entries = await readdir(context.sessionsRoot, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return Object.freeze([]); throw error; }
  throwIfCancelled(signal);
  const candidates = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith('.journal.ndjson'))
    .slice(0, MAX_SESSION_CANDIDATES).map(async (entry) => {
      const path = join(context.sessionsRoot, entry.name);
      const info = await stat(path);
      return { path, sessionId: entry.name.slice(0, -'.journal.ndjson'.length), modifiedMs: info.mtimeMs };
    }));
  throwIfCancelled(signal);
  const selected = candidates.sort((a, b) => b.modifiedMs - a.modifiedMs).slice(0, bounded);
  const sessions = await Promise.all(selected.map(async (candidate) => {
    throwIfCancelled(signal);
    const page = await readDiagnosticPage(candidate.path, SESSION_DIAGNOSTIC_RECORD_LIMIT);
    const header = (await readJournalPrefix(candidate.path, 1))[0]?.payload ?? {};
    throwIfCancelled(signal);
    const turnId = latestTurnId(page.records);
    const records = turnId ? page.records.filter((record) => recordTurnId(record) === turnId) : [];
    const terminal = [...records].reverse().find((record) => record.type === 'turn_outcome')?.payload ?? null;
    const hosted = header.executionManifest != null;
    const mission = header.mission != null;
    return Object.freeze({
      session_id: candidate.sessionId, current: candidate.sessionId === context.sessionId,
      updated_at: new Date(candidate.modifiedMs).toISOString(), latest_turn_id: turnId,
      latest_outcome: terminal?.outcome ?? (turnId ? 'active_or_interrupted' : null),
      latest_failure_code: terminal?.failure?.code ?? null,
      resumable: !hosted && !mission,
      resume_blocked_reason: hosted ? 'authenticated_host_session' : mission ? 'mission_session' : null,
    });
  }));
  return Object.freeze(sessions);
}

function hasOnlyKeys(args, allowedKeys) {
  return Boolean(args) && typeof args === 'object' && !Array.isArray(args)
    && Object.keys(args).every((key) => allowedKeys.includes(key));
}

function containedSessionJournalPath(sessionsRoot, sessionId) {
  if (!sessionsRoot) throw new ContractError('diagnostics_unavailable', 'the runtime session catalog is unavailable');
  const root = resolve(sessionsRoot);
  const candidate = resolve(root, `${sessionId}.journal.ndjson`);
  const fromRoot = relative(root, candidate);
  if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new ContractError('tool_schema_invalid', 'session_id resolves outside the durable session catalog');
  }
  return candidate;
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw new ContractError('tool_cancelled', 'tool was cancelled');
}

function optionalIdentifier(value) {
  return value === undefined || (typeof value === 'string' && value.length >= 1 && value.length <= 256);
}

async function readDiagnosticPage(path, limit = 2_000) {
  try { return await readJournalPage(path, { limit }); }
  catch (error) {
    if (error.code === 'ENOENT') throw new ContractError('diagnostics_session_not_found', 'the requested durable session was not found');
    throw error;
  }
}

async function readRecentDiagnosticRecords(path, signal) {
  const records = [];
  let beforeSequence = Number.MAX_SAFE_INTEGER;
  let hasMore = true;
  try {
    while (hasMore && records.length < MAX_TURN_DIAGNOSTIC_RECORDS) {
      throwIfCancelled(signal);
      const page = await readJournalPage(path, {
        limit: Math.min(TURN_DIAGNOSTIC_PAGE_LIMIT, MAX_TURN_DIAGNOSTIC_RECORDS - records.length),
        beforeSequence,
      });
      records.unshift(...page.records);
      hasMore = page.hasMore;
      if (page.beforeSequence === null || page.beforeSequence >= beforeSequence) break;
      beforeSequence = page.beforeSequence;
    }
  } catch (error) {
    if (error.code === 'ENOENT') throw new ContractError('diagnostics_session_not_found', 'the requested durable session was not found');
    throw error;
  }
  return Object.freeze({ records: Object.freeze(records), hasMore });
}

function recentTurnCatalog(records) {
  const turns = new Map();
  for (const record of records) {
    const turnId = recordTurnId(record);
    if (!turnId) continue;
    const current = turns.get(turnId) ?? {
      turn_id: turnId, outcome: 'active_or_interrupted', failure_code: null,
    };
    if (record.type === 'turn_outcome') {
      current.outcome = record.payload?.outcome ?? current.outcome;
      current.failure_code = record.payload?.failure?.code ?? null;
    }
    turns.delete(turnId);
    turns.set(turnId, current);
  }
  return Object.freeze([...turns.values()].slice(-MAX_AVAILABLE_TURNS).reverse()
    .map((item, turnOffset) => Object.freeze({ ...item, turn_offset: turnOffset })));
}

function selectTurnByOffset(availableTurns, offset, activeTurnId) {
  const activeIndex = activeTurnId
    ? availableTurns.findIndex((item) => item.turn_id === activeTurnId) : -1;
  if (activeIndex <= 0) return availableTurns[offset]?.turn_id ?? null;
  const ordered = [availableTurns[activeIndex], ...availableTurns.filter((_item, index) => index !== activeIndex)];
  return ordered[offset]?.turn_id ?? null;
}

function latestTurnId(records) {
  for (const record of [...records].reverse()) {
    const id = recordTurnId(record);
    if (id) return id;
  }
  return null;
}

function recordTurnId(record) {
  return record?.payload?.turn_id ?? record?.payload?.turnId ?? null;
}

function summarize(sessionId, turnId, records, state) {
  const providerAttempts = []; const recoveries = []; const tools = []; const compactions = [];
  let terminal = null;
  for (const record of records) {
    const payload = record.payload ?? {};
    if (record.type === 'lifecycle_event' && payload.event_name === 'provider_attempt.terminal') {
      providerAttempts.push({ outcome: payload.outcome ?? null, step_id: payload.step_id ?? null, attempt_id: payload.attempt_id ?? null });
    } else if (record.type === 'recovery_decision') {
      recoveries.push({ category: payload.category ?? null, action: payload.action ?? null, count: payload.count ?? null });
    } else if (record.type === 'tool_result') {
      tools.push({
        tool: payload.toolName ?? null, tool_lifecycle_status: toolLifecycleStatus(payload),
        review_outcome: toolReviewOutcome(payload), reason_code: payload.reasonCode ?? null,
      });
    } else if (record.type === 'compaction') {
      compactions.push({ omitted_records: payload.omitted ?? null, objective_present: Boolean(payload.continuation?.objective), next_actions: payload.continuation?.nextActions?.length ?? 0 });
    } else if (record.type === 'turn_outcome') {
      terminal = { outcome: payload.outcome ?? null, failure_code: payload.failure?.code ?? null, retryable: payload.retryable ?? false };
    }
  }
  return {
    schema: 'nna.turn_diagnostic.v1', session_id: sessionId, turn_id: turnId, runtime_state: state ?? null,
    terminal, provider_attempts: providerAttempts.slice(-32), recovery: recoveries.slice(-32),
    tools: tools.slice(-64), compactions: compactions.slice(-8), content_redacted: true,
  };
}
