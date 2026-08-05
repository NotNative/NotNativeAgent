// SPDX-License-Identifier: Apache-2.0
import { valueOverlay } from './tui-overlays.js';

export function openSessionStats(workspace) {
  const session = workspace.projection.active();
  workspace.projection.openOverlay(valueOverlay('stats', 'Conversation statistics', sessionStats(session)));
}

export function sessionStats(session) {
  const records = [...(session?.historyRecords ?? []), ...(session?.records ?? [])];
  const turns = records.filter((record) => record.type === 'turn_result');
  const tools = records.filter((record) => record.type === 'tool_status' && record.status !== 'running');
  const reviews = records.filter((record) => record.type === 'review_status');
  const repair = repairStats(turns);
  const usage = session?.usage ?? {};
  return Object.freeze({
    state: session?.state ?? 'unknown',
    turns: Object.freeze({
      total: turns.length,
      completed: turns.filter((record) => record.outcome === 'completed').length,
      needs_input: turns.filter((record) => record.outcome === 'needs_input').length,
      failed: turns.filter((record) => ['failed', 'limit_reached'].includes(record.outcome)).length,
      elapsed_ms: sum(turns, 'elapsed_ms'),
    }),
    tools: Object.freeze({
      total: tools.length,
      succeeded: tools.filter((record) => ['succeeded', 'duplicate_ignored'].includes(record.status)).length,
      failed: tools.filter((record) => !['succeeded', 'duplicate_ignored'].includes(record.status)).length,
    }),
    reviews: Object.freeze({
      total: reviews.length,
      denied: reviews.filter((record) => record.outcome && record.outcome !== 'approve').length,
    }),
    repair,
    tokens: Object.freeze({
      input: number(usage.prompt_tokens ?? usage.input_tokens),
      output: number(usage.completion_tokens ?? usage.output_tokens),
      total: number(usage.total_tokens ?? usage.totalTokens),
    }),
    context: Object.freeze({
      tokens: number(session?.contextTokens),
      limit_tokens: number(session?.contextLimitTokens),
      percent: percent(session?.contextTokens, session?.contextLimitTokens),
      measurement: session?.contextMeasurement ?? 'unavailable',
      source: session?.contextSource ?? 'unavailable',
    }),
  });
}

function repairStats(turns) {
  const affected = turns.filter((turn) => Array.isArray(turn.recovery) && turn.recovery.length > 0);
  const actions = affected.flatMap((turn, index) => turn.recovery.map((item) => ({
    kind: repairKind(item), terminal_outcome: turn.outcome, turn: turn.turn_id ?? `turn-${index}`,
  })));
  const recovered = affected.filter((turn) => !['failed', 'incomplete', 'limit_reached'].includes(turn.outcome)).length;
  const kinds = {};
  for (const action of actions) {
    const entry = kinds[action.kind] ?? { attempts: 0, recovered: new Set(), exhausted: new Set() };
    entry.attempts += 1;
    if (['failed', 'incomplete', 'limit_reached'].includes(action.terminal_outcome)) entry.exhausted.add(action.turn);
    else entry.recovered.add(action.turn);
    kinds[action.kind] = entry;
  }
  const byKind = Object.fromEntries(Object.entries(kinds).map(([kind, value]) => [kind, Object.freeze({
    attempts: value.attempts, recovered_turns: value.recovered.size, exhausted_turns: value.exhausted.size,
  })]));
  const firstPass = turns.length - affected.length;
  return Object.freeze({
    first_pass_turns: firstPass,
    first_pass_rate: turns.length > 0 ? `${Math.round((firstPass / turns.length) * 1000) / 10}%` : 'n/a',
    affected_turns: affected.length,
    attempts: actions.length,
    recovered_turns: recovered,
    exhausted_turns: affected.length - recovered,
    rescue_rate: affected.length > 0 ? `${Math.round((recovered / affected.length) * 1000) / 10}%` : 'n/a',
    by_kind: Object.freeze(byKind),
  });
}

function repairKind(action) {
  const category = String(action?.category ?? '').trim();
  if (category) return category;
  const name = String(action?.action ?? '').trim();
  return name || 'unclassified_repair';
}

function sum(records, key) {
  return records.reduce((total, record) => total + (Number.isFinite(record[key]) ? record[key] : 0), 0);
}

function number(value) {
  return Number.isFinite(value) ? value : 'unavailable';
}

function percent(value, limit) {
  return Number.isFinite(value) && Number.isFinite(limit) && limit > 0
    ? `${Math.min(100, Math.round((value / limit) * 1000) / 10)}%` : 'unavailable';
}
