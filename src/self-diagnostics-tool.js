// SPDX-License-Identifier: Apache-2.0
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readJournalPage } from './store.js';
import { ContractError } from './ids.js';

const SESSION_ID = /^[A-Za-z0-9_-]{1,256}$/u;

export function selfDiagnosticsDefinitions(contextProvider) {
  return [diagnoseTurnDefinition(contextProvider), listSessionsDefinition(contextProvider)];
}

function diagnoseTurnDefinition(contextProvider) {
  return {
    name: 'nna.diagnose_turn', version: 1,
    purpose: 'Inspect bounded, content-redacted lifecycle evidence for the active or most recent NNA turn. Use this when troubleshooting NNA behavior before guessing from visible output.',
    sideEffect: 'read_only', scope: 'runtime_diagnostics', cancellation: true, timeoutMs: 10_000,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        session_id: { type: 'string', minLength: 1, maxLength: 256 },
        turn_id: { type: 'string', minLength: 1, maxLength: 256 },
      },
    },
    validate: async (args) => {
      if (!args || typeof args !== 'object' || Array.isArray(args)
        || Object.keys(args).some((key) => !['session_id', 'turn_id'].includes(key))
        || !optionalIdentifier(args.session_id) || !optionalIdentifier(args.turn_id)
        || (args.session_id !== undefined && !SESSION_ID.test(args.session_id))) {
        throw new ContractError('tool_schema_invalid', 'session_id and turn_id must be optional bounded identifiers');
      }
      return { args: { session_id: args.session_id ?? null, turn_id: args.turn_id ?? null }, resolved: null };
    },
    executor: async (request, signal) => {
      if (signal.aborted) throw new ContractError('tool_cancelled', 'tool was cancelled');
      const context = contextProvider?.();
      if (!context?.journalPath) throw new ContractError('diagnostics_unavailable', 'the current runtime has no readable durable journal');
      const sessionId = request.args.session_id ?? context.sessionId;
      const journalPath = request.args.session_id
        ? join(context.sessionsRoot, `${request.args.session_id}.journal.ndjson`) : context.journalPath;
      const page = await readDiagnosticPage(journalPath);
      const turnId = request.args.turn_id
        ?? (sessionId === context.sessionId ? context.activeTurnId : null) ?? latestTurnId(page.records);
      if (!turnId) throw new ContractError('diagnostics_turn_unavailable', 'no recent turn is available to diagnose');
      const records = page.records.filter((record) => recordTurnId(record) === turnId);
      if (records.length === 0) throw new ContractError('diagnostics_turn_not_found', 'the requested turn is outside the bounded recent journal window');
      return {
        content: JSON.stringify(summarize(sessionId, turnId, records, sessionId === context.sessionId ? context.state : null), null, 2),
        metadata: { session_id: sessionId, turn_id: turnId, records_examined: records.length, redacted: true, truncated_history: page.hasMore },
      };
    },
  };
}

function listSessionsDefinition(contextProvider) {
  return {
    name: 'nna.list_sessions', version: 1,
    purpose: 'List bounded recent durable NNA sessions so a different Console run can be selected for diagnosis.',
    sideEffect: 'read_only', scope: 'runtime_diagnostics', cancellation: true, timeoutMs: 10_000,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { limit: { type: 'integer', minimum: 1, maximum: 64 } },
    },
    validate: async (args) => {
      if (!args || typeof args !== 'object' || Array.isArray(args)
        || Object.keys(args).some((key) => key !== 'limit')
        || (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 64))) {
        throw new ContractError('tool_schema_invalid', 'limit must be an optional integer from 1 to 64');
      }
      return { args: { limit: args.limit ?? 20 }, resolved: null };
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

export async function listDurableSessions(context, limit = 20, signal = null) {
  if (!context?.sessionsRoot) throw new ContractError('diagnostics_unavailable', 'the runtime session catalog is unavailable');
  const bounded = Number.isInteger(limit) ? Math.max(1, Math.min(64, limit)) : 20;
  let entries;
  try { entries = await readdir(context.sessionsRoot, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return Object.freeze([]); throw error; }
  const candidates = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith('.journal.ndjson'))
    .slice(0, 512).map(async (entry) => {
      const path = join(context.sessionsRoot, entry.name);
      const info = await stat(path);
      return { path, sessionId: entry.name.slice(0, -'.journal.ndjson'.length), modifiedMs: info.mtimeMs };
    }));
  const selected = candidates.sort((a, b) => b.modifiedMs - a.modifiedMs).slice(0, bounded);
  const sessions = [];
  for (const candidate of selected) {
    if (signal?.aborted) throw new ContractError('tool_cancelled', 'tool was cancelled');
    const page = await readDiagnosticPage(candidate.path, 256);
    const turnId = latestTurnId(page.records);
    const records = turnId ? page.records.filter((record) => recordTurnId(record) === turnId) : [];
    const terminal = [...records].reverse().find((record) => record.type === 'turn_outcome')?.payload ?? null;
    sessions.push(Object.freeze({
      session_id: candidate.sessionId, current: candidate.sessionId === context.sessionId,
      updated_at: new Date(candidate.modifiedMs).toISOString(), latest_turn_id: turnId,
      latest_outcome: terminal?.outcome ?? (turnId ? 'active_or_interrupted' : null),
      latest_failure_code: terminal?.failure?.code ?? null,
    }));
  }
  return Object.freeze(sessions);
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
      tools.push({ tool: payload.toolName ?? null, status: payload.status ?? null, reason_code: payload.reasonCode ?? null });
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
