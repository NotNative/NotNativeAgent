// SPDX-License-Identifier: Apache-2.0
import { detailedTokenText, receiptTokenText } from '../experience/token-accounting.js';
import { isTerminalToolStatus } from '../experience/tool-lifecycle.js';
import { wrapIndentedTerminalLine } from './terminal-markdown.js';

const ACTIVITY_TYPES = Object.freeze(['tool_status', 'review_status', 'state_status', 'queue_status', 'subagent_progress']);

export function isActivity(record) {
  return ACTIVITY_TYPES.includes(record.type);
}

export function activityByTurn(records, completed) {
  const result = new Map();
  for (const record of records) {
    if (!isActivity(record) || !completed.has(record.turn_id)) continue;
    const values = result.get(record.turn_id) ?? [];
    values.push(record);
    result.set(record.turn_id, values);
  }
  return result;
}

export function summarizeActivity(records) {
  const tools = new Map();
  const reviews = new Set();
  const toolStatuses = new Map();
  let engine = false;
  for (const record of records) {
    const id = record.tool_request_id ?? record.provider_call_id;
    if (record.type === 'tool_status') {
      const key = id ?? record.tool ?? `tool:${tools.size}`;
      tools.set(key, record.tool);
      toolStatuses.set(key, record.status);
    }
    if (record.type === 'review_status') reviews.add(id ?? record.decision_id ?? `review:${reviews.size}`);
    if (record.type === 'state_status' || record.type === 'queue_status') engine = true;
  }
  let flagged = 0;
  for (const status of toolStatuses.values()) {
    if (isTerminalToolStatus(status) && status !== 'succeeded' && status !== 'duplicate_ignored') flagged += 1;
  }
  return { tools, reviews, engine, flagged };
}

// Closed outcome vocabulary for receipt identity and decoration. Outcomes that
// are not listed here share one neutral treatment instead of leaking arbitrary
// strings into line kinds.
const RECEIPT_GLYPHS = Object.freeze({
  completed: ['●', '*'],
  cancelled: ['◌', '-'],
  needs_input: ['?', '?'],
  blocked: ['?', '?'],
  failed: ['✗', '!'],
  incomplete: ['✗', '!'],
});
const RECEIPT_OUTCOME_KINDS = new Set(Object.keys(RECEIPT_GLYPHS));

export function receiptOutcomeKind(outcome) {
  return RECEIPT_OUTCOME_KINDS.has(outcome) ? outcome : 'other';
}

export function turnReceipt(record, summary, mode, width, capabilities = {}) {
  const toolCount = summary.tools.size;
  const reviewCount = summary.reviews.size;
  const outcome = receiptOutcomeKind(record.outcome);
  const successful = outcome === 'completed';
  const [unicodeMarker, asciiMarker] = RECEIPT_GLYPHS[outcome] ?? ['?', '?'];
  const marker = capabilities.unicode === false ? asciiMarker : unicodeMarker;
  const label = successful ? 'Turn finished' : record.outcome === 'cancelled'
    ? 'Turn cancelled' : record.outcome === 'needs_input' ? 'Turn needs input'
      : record.outcome === 'blocked' ? 'Turn blocked'
      : record.outcome === 'incomplete' ? 'Turn ended without completion'
      : `Turn ${record.outcome.replaceAll('_', ' ')}`;
  const toolsField = toolCount ? `${toolCount} tool${toolCount === 1 ? '' : 's'}` : null;
  const flaggedField = summary.flagged ? `${summary.flagged} flagged` : null;
  const reviewsField = reviewCount ? `${reviewCount} review${reviewCount === 1 ? '' : 's'}` : null;
  if (successful || ['blocked', 'needs_input'].includes(outcome)) {
    const basic = [
      Number.isFinite(record.elapsed_ms) ? formatDuration(record.elapsed_ms) : null,
      receiptTokenText(record),
      toolsField,
      flaggedField,
      reviewsField,
      toolCount || reviewCount ? `Ctrl+O ${mode === 'details' ? 'collapse' : 'details'}` : null,
    ].filter(Boolean);
    return wrap(basic.length ? `  ${marker} ${basic.join(' | ')}` : `  ${marker}`, width);
  }
  const details = [
    Number.isFinite(record.elapsed_ms) ? formatDuration(record.elapsed_ms) : null,
    detailedTokenText(record),
    toolsField ?? (reviewCount ? null : 'direct response'),
    flaggedField,
    reviewsField,
    record.failure?.code ? `code ${record.failure.code}` : null,
    recoveryAction(record),
    toolCount || reviewCount ? `Ctrl+O ${mode === 'details' ? 'collapse' : 'details'}` : null,
  ].filter(Boolean);
  return wrap(`  ${marker} ${label}${details.length ? ` | ${details.join(' | ')}` : ''}`, width);
}

function recoveryAction(record) {
  if (record.outcome === 'needs_input') return null;
  if (record.outcome === 'blocked') return 'review the blocker above';
  if (record.outcome === 'incomplete') return 'review the explanation above';
  if (record.retryable) return 'retry: Up then Enter';
  if (!['completed', 'cancelled'].includes(record.outcome)) return 'inspect: /health';
  return null;
}

function formatDuration(milliseconds) {
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  const seconds = milliseconds / 1000;
  return seconds < 60 ? `${seconds.toFixed(seconds < 10 ? 1 : 0)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function wrap(value, width) {
  return String(value).split(/\r?\n/u).flatMap((line) => wrapIndentedTerminalLine(line, width)).slice(0, 64);
}
