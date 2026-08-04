// SPDX-License-Identifier: Apache-2.0
import { readJournalPage } from './store.js';
import { ContractError } from './ids.js';

export function selfDiagnosticsDefinition(contextProvider) {
  return {
    name: 'nna.diagnose_turn', version: 1,
    purpose: 'Inspect bounded, content-redacted lifecycle evidence for the active or most recent NNA turn. Use this when troubleshooting NNA behavior before guessing from visible output.',
    sideEffect: 'read_only', scope: 'runtime_diagnostics', cancellation: true, timeoutMs: 10_000,
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { turn_id: { type: 'string', minLength: 1, maxLength: 256 } },
    },
    validate: async (args) => {
      if (!args || typeof args !== 'object' || Array.isArray(args)
        || Object.keys(args).some((key) => key !== 'turn_id')
        || (args.turn_id !== undefined && typeof args.turn_id !== 'string')) {
        throw new ContractError('tool_schema_invalid', 'turn_id must be an optional string');
      }
      return { args: { turn_id: args.turn_id ?? null }, resolved: null };
    },
    executor: async (request, signal) => {
      if (signal.aborted) throw new ContractError('tool_cancelled', 'tool was cancelled');
      const context = contextProvider?.();
      if (!context?.journalPath) throw new ContractError('diagnostics_unavailable', 'the current runtime has no readable durable journal');
      const page = await readJournalPage(context.journalPath, { limit: 2_000 });
      const turnId = request.args.turn_id ?? context.activeTurnId ?? latestTurnId(page.records);
      if (!turnId) throw new ContractError('diagnostics_turn_unavailable', 'no recent turn is available to diagnose');
      const records = page.records.filter((record) => recordTurnId(record) === turnId);
      if (records.length === 0) throw new ContractError('diagnostics_turn_not_found', 'the requested turn is outside the bounded recent journal window');
      return {
        content: JSON.stringify(summarize(turnId, records, context.state), null, 2),
        metadata: { turn_id: turnId, records_examined: records.length, redacted: true, truncated_history: page.hasMore },
      };
    },
  };
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

function summarize(turnId, records, state) {
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
    schema: 'nna.turn_diagnostic.v1', turn_id: turnId, runtime_state: state ?? null,
    terminal, provider_attempts: providerAttempts.slice(-32), recovery: recoveries.slice(-32),
    tools: tools.slice(-64), compactions: compactions.slice(-8), content_redacted: true,
  };
}
