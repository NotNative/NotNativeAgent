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
