// SPDX-License-Identifier: Apache-2.0
import { displayWidth, wrapTerminalLine } from './terminal-markdown.js';
import { TUI_THEME } from './theme.js';
import { isIntermediateToolStatus } from '../experience/tool-lifecycle.js';

const TOOL_STATUS = Object.freeze({
  REVIEW_PENDING: 'review_pending', APPROVED: 'approved', RUNNING: 'running',
  SUCCEEDED: 'succeeded', DUPLICATE: 'duplicate_ignored', COMPLETED_NONZERO: 'completed_nonzero',
});
const COMPLETED_TASK_VERBS = Object.freeze({
  reviewing: 'reviewed', updating: 'updated', testing: 'tested', planning: 'planned', 'working on': 'finished',
});
const MAX_TARGET_LENGTH = 56;
const TARGET_ELLIPSIS_LENGTH = 3;

export function decorateToolActivityLine(line, lineKind, paint) {
  if (lineKind?.startsWith('tool_status:')) {
    const status = lineKind.slice('tool_status:'.length);
    if (status === 'observed') return paint(TUI_THEME.muted, line);
    if (status === TOOL_STATUS.SUCCEEDED) {
      const match = line.match(/^(\s*)(\u2713)(.*)$/u);
      return match ? `${match[1]}${paint(TUI_THEME.success, match[2])}${paint(TUI_THEME.muted, match[3])}` : paint(TUI_THEME.muted, line);
    }
    if ([TOOL_STATUS.REVIEW_PENDING, TOOL_STATUS.APPROVED, TOOL_STATUS.RUNNING].includes(status)) {
      const style = status === TOOL_STATUS.REVIEW_PENDING ? TUI_THEME.warning : TUI_THEME.success;
      const match = line.match(/^(\s*)(●|\+)(.*)$/u);
      return match ? `${match[1]}${paint(style, match[2])}${paint(TUI_THEME.muted, match[3])}` : paint(TUI_THEME.muted, line);
    }
    if (status === TOOL_STATUS.COMPLETED_NONZERO) return paint(TUI_THEME.warning, line);
    return paint(status === TOOL_STATUS.RUNNING ? TUI_THEME.muted : TUI_THEME.danger, line);
  }
  if (/^\s+(?:Review|Result):/u.test(line)) return paint(TUI_THEME.muted, line);
  const match = line.match(/^(\s*)(\u2713)(.*)$/u);
  if (match) return `${match[1]}${paint(TUI_THEME.success, match[2])}${paint(TUI_THEME.muted, match[3])}`;
  if (/^\s+\+/u.test(line)) return paint(TUI_THEME.muted, line);
  if (/^\s+>|^\s+</u.test(line)) return paint(TUI_THEME.activity, line);
  if (/^\s+X|^!/u.test(line)) return paint(TUI_THEME.danger, line);
  return null;
}

export function subagentProgressLines(record, width) {
  const direction = record.phase === 'returned' ? '<' : record.phase === 'failed' ? 'X' : '>';
  const phase = { started: 'started', returned: 'completed', failed: 'failed' }[record.phase];
  if (!phase) return [];
  const text = record.phase === 'returned' ? completedTask(record.text) : record.text;
  const prefix = `    ${direction} ${record.agent_type ?? 'sub-agent'} ${phase} · `;
  return wrapTerminalLine(text ?? '', width, prefix, ' '.repeat(displayWidth(prefix)));
}

function completedTask(value) {
  return String(value ?? '').replace(/^(reviewing|updating|testing|planning|working on)\b/u, (verb) => COMPLETED_TASK_VERBS[verb]);
}

export function compactActivityRows(records) {
  return toolCalls(records).map((item) => {
    const timing = formatElapsed(item.result?.elapsed_ms);
    const target = toolTargetSuffix(item);
    const failure = toolFailureSuffix(item.result);
    return `    ${toolSymbol(item.result?.status, item.result?.observation_outcome)} ${item.tool}${target}${timing}${toolObservationSuffix(item.result)}${failure}`;
  });
}

export function collapsedFailureRows(records) {
  const failed = toolCalls(records).filter((item) => !successfulToolStatus(item.result?.status));
  const rows = failed.slice(0, 2).map((item) => {
    const timing = formatElapsed(item.result?.elapsed_ms);
    return `    X ${item.tool}${toolTargetSuffix(item)}${timing}${toolFailureSuffix(item.result)}`;
  });
  if (failed.length > rows.length) rows.push(`    X ${failed.length - rows.length} more failed call${failed.length - rows.length === 1 ? '' : 's'}`);
  return rows;
}

export function summaryActivityRows(records) {
  const groups = new Map();
  for (const item of toolCalls(records)) {
    const group = groups.get(item.tool) ?? { tool: item.tool, count: 0, failed: 0, nonzero: 0, observed: 0, elapsed: 0, targets: [] };
    group.count += 1;
    if (item.result?.status === TOOL_STATUS.COMPLETED_NONZERO) group.nonzero += 1;
    else if (!successfulToolStatus(item.result?.status)) group.failed += 1;
    if (item.result?.observation_outcome) group.observed += 1;
    if (Number.isFinite(item.result?.elapsed_ms)) group.elapsed += item.result.elapsed_ms;
    if (item.target && !group.targets.includes(item.target)) group.targets.push(item.target);
    groups.set(item.tool, group);
  }
  const rows = ['    Activity summary'];
  for (const group of groups.values()) rows.push(summaryGroupRow(group));
  return rows;
}

export function activityDetailRows(records, width, wrap) {
  const lines = [wrap('    v Activity detail', width)[0]];
  for (const item of toolCalls(records)) {
    const boundary = [item.effect, item.scope].filter(Boolean).join(' | ');
    lines.push(...wrap(`    ${toolSymbol(item.result?.status, item.result?.observation_outcome)} ${item.tool}${item.target ? ` (${item.target})` : ''}${boundary ? ` | ${boundary}` : ''}`, width));
    if (item.arguments) lines.push(...wrap(`      Arguments: ${JSON.stringify(item.arguments)}`, width));
    if (item.review) lines.push(...wrap(`      Review: ${item.review.outcome ?? '--'} | ${item.review.reason_code ?? '--'}`, width));
    if (item.result) lines.push(...wrap(`      Result: ${resultDetail(item.result)}`, width));
  }
  for (const record of records.filter((item) => item.type === 'subagent_progress')) {
    lines.push(...wrap(`      ${record.agent_type ?? 'sub-agent'} ${record.phase} | ${record.text ?? ''}`, width));
  }
  return lines;
}

function summaryGroupRow(group) {
  const succeeded = group.count - group.failed - group.nonzero - group.observed;
  const parts = [`${succeeded} succeeded`];
  if (group.observed) parts.push(`${group.observed} neutral observation${group.observed === 1 ? '' : 's'}`);
  if (group.nonzero) parts.push(`${group.nonzero} completed nonzero`);
  if (group.failed) parts.push(`${group.failed} failed`);
  const status = group.failed || group.nonzero || group.observed ? parts.join(' | ') : 'all succeeded';
  const elapsed = group.elapsed ? ` | ${Math.round(group.elapsed)} ms` : '';
  const targets = group.targets.slice(0, 2).map((value) => compactTarget(value));
  const target = targets.length ? ` | ${targets.join('; ')}${group.targets.length > 2 ? '; ...' : ''}` : '';
  return `      ${group.failed ? 'X' : group.nonzero ? '!' : group.observed ? '–' : '\u2713'} ${group.tool} x${group.count} | ${status}${elapsed}${target}`;
}

function compactTarget(value) {
  const text = String(value).replace(/\s+/gu, ' ').trim();
  return text.length > MAX_TARGET_LENGTH ? `${text.slice(0, MAX_TARGET_LENGTH - TARGET_ELLIPSIS_LENGTH)}...` : text;
}

function toolCalls(records) {
  const calls = new Map();
  for (const record of records) {
    if (!['tool_status', 'review_status'].includes(record.type)) continue;
    const id = record.tool_request_id ?? record.provider_call_id ?? `activity:${calls.size}`;
    const item = calls.get(id) ?? { tool: record.tool ?? 'tool request', target: null, arguments: null, effect: null, scope: null, review: null, result: null };
    if (record.type === 'review_status') item.review = record;
    else Object.assign(item, { tool: record.tool, target: record.target ?? item.target, arguments: record.arguments ?? item.arguments, effect: record.effect ?? item.effect, scope: record.scope ?? item.scope, result: record });
    calls.set(id, item);
  }
  return [...calls.values()];
}

export function toolTargetSuffix(item) {
  if (item.target) return ` (${item.target})`;
  return !isIntermediateToolStatus(item.result?.status)
    && item.result?.status !== 'succeeded' && item.tool.startsWith('fs.') ? ' (path unavailable)' : '';
}

export function toolFailureSuffix(record) {
  if (!record || isIntermediateToolStatus(record.status) || successfulToolStatus(record.status)) return '';
  if (record.status === TOOL_STATUS.COMPLETED_NONZERO) return ` | completed · exit ${record.exit_code ?? 'nonzero'}`;
  if (record.reason_code === 'process_signal_exit') return ` | signal ${record.signal ?? 'unknown'}`;
  const reason = [record.reason_code, record.failure_reason].filter(Boolean).join(': ');
  return reason ? ` | ${reason}` : ` | ${record.status}`;
}

export function toolFailureText(record) {
  return [record?.reason_code, record?.failure_reason].filter(Boolean).join(': ');
}

function resultDetail(record) {
  const values = [record.status === TOOL_STATUS.COMPLETED_NONZERO ? `completed · exit ${record.exit_code ?? 'nonzero'}` : record.status];
  if (Number.isFinite(record.elapsed_ms)) values.push(`${Math.round(record.elapsed_ms)} ms`);
  if (record.effect_certainty) values.push(`effect ${record.effect_certainty}`);
  if (record.observation_outcome) values.push(observationLabel(record.observation_outcome));
  const failure = toolFailureText(record); if (failure) values.push(failure);
  return values.join(' | ');
}

export function toolSymbol(status, observationOutcome = null) {
  if (!status) return '-';
  if (status === TOOL_STATUS.REVIEW_PENDING || status === TOOL_STATUS.APPROVED) return '\u25cf';
  if (status === TOOL_STATUS.RUNNING) return '+';
  if (status === TOOL_STATUS.SUCCEEDED) return observationOutcome ? '–' : '\u2713';
  if (status === TOOL_STATUS.COMPLETED_NONZERO) return '!';
  return 'X';
}

function toolObservationSuffix(record) {
  return record?.observation_outcome ? ` | ${observationLabel(record.observation_outcome)}` : '';
}

function observationLabel(value) {
  return { no_matches: 'no matches', target_not_found: 'target not found', empty_directory: 'empty directory' }[value] ?? value;
}

function successfulToolStatus(status) {
  return status === TOOL_STATUS.SUCCEEDED || status === TOOL_STATUS.DUPLICATE;
}

function formatElapsed(elapsedMs) {
  return Number.isFinite(elapsedMs) ? ` | ${Math.round(elapsedMs)} ms` : '';
}
