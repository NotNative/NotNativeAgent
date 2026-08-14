// SPDX-License-Identifier: Apache-2.0
import { displayWidth, wrapTerminalLine } from './terminal-markdown.js';
import { TUI_THEME } from './tui-theme.js';

export function decorateToolActivityLine(line, lineKind, paint) {
  if (lineKind?.startsWith('tool_status:')) {
    const status = lineKind.slice('tool_status:'.length);
    if (status === 'succeeded') {
      const match = line.match(/^(\s*)(\u2713)(.*)$/u);
      return match ? `${match[1]}${paint(TUI_THEME.success, match[2])}${paint(TUI_THEME.muted, match[3])}` : paint(TUI_THEME.muted, line);
    }
    return paint(status === 'running' ? TUI_THEME.muted : TUI_THEME.danger, line);
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
  const phase = { started: 'started', working: 'reports', returned: 'returned', failed: 'failed' }[record.phase] ?? record.phase;
  const prefix = `    ${direction} ${record.agent_type ?? 'sub-agent'} ${phase} | `;
  return wrapTerminalLine(record.text ?? '', width, prefix, ' '.repeat(displayWidth(prefix)));
}

export function compactActivityRows(records) {
  return toolCalls(records).map((item) => {
    const timing = Number.isFinite(item.result?.elapsed_ms) ? ` | ${Math.round(item.result.elapsed_ms)} ms` : '';
    const target = toolTargetSuffix(item);
    const failure = toolFailureSuffix(item.result);
    return `    ${toolSymbol(item.result?.status)} ${item.tool}${target}${timing}${failure}`;
  });
}

export function collapsedFailureRows(records) {
  const failed = toolCalls(records).filter((item) => !['succeeded', 'duplicate_ignored'].includes(item.result?.status));
  const rows = failed.slice(0, 2).map((item) => {
    const timing = Number.isFinite(item.result?.elapsed_ms) ? ` | ${Math.round(item.result.elapsed_ms)} ms` : '';
    return `    X ${item.tool}${toolTargetSuffix(item)}${timing}${toolFailureSuffix(item.result)}`;
  });
  if (failed.length > rows.length) rows.push(`    X ${failed.length - rows.length} more failed call${failed.length - rows.length === 1 ? '' : 's'}`);
  return rows;
}

export function summaryActivityRows(records) {
  const groups = new Map();
  for (const item of toolCalls(records)) {
    const group = groups.get(item.tool) ?? { tool: item.tool, count: 0, failed: 0, elapsed: 0, targets: [] };
    group.count += 1;
    if (!['succeeded', 'duplicate_ignored'].includes(item.result?.status)) group.failed += 1;
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
    lines.push(...wrap(`    ${toolSymbol(item.result?.status)} ${item.tool}${item.target ? ` (${item.target})` : ''}${boundary ? ` | ${boundary}` : ''}`, width));
    if (item.arguments) lines.push(...wrap(`      Arguments: ${JSON.stringify(item.arguments)}`, width));
    if (item.review) lines.push(...wrap(`      Review: ${item.review.outcome} | ${item.review.reason_code ?? '--'}`, width));
    if (item.result) lines.push(...wrap(`      Result: ${resultDetail(item.result)}`, width));
  }
  for (const record of records.filter((item) => item.type === 'subagent_progress')) {
    lines.push(...wrap(`      ${record.agent_type ?? 'sub-agent'} ${record.phase} | ${record.text ?? ''}`, width));
  }
  return lines;
}

function summaryGroupRow(group) {
  const succeeded = group.count - group.failed;
  const status = group.failed ? `${succeeded} succeeded | ${group.failed} failed` : 'all succeeded';
  const elapsed = group.elapsed ? ` | ${Math.round(group.elapsed)} ms` : '';
  const targets = group.targets.slice(0, 2).map((value) => compactTarget(value));
  const target = targets.length ? ` | ${targets.join('; ')}${group.targets.length > 2 ? '; ...' : ''}` : '';
  return `      ${group.failed ? 'X' : '\u2713'} ${group.tool} x${group.count} | ${status}${elapsed}${target}`;
}

function compactTarget(value) {
  const text = String(value).replace(/\s+/gu, ' ').trim();
  return text.length > 56 ? `${text.slice(0, 53)}...` : text;
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
  return item.result?.status !== 'succeeded' && item.tool.startsWith('fs.') ? ' (path unavailable)' : '';
}

export function toolFailureSuffix(record) {
  if (!record || ['running', 'succeeded', 'duplicate_ignored'].includes(record.status)) return '';
  const reason = [record.reason_code, record.failure_reason].filter(Boolean).join(': ');
  return reason ? ` | ${reason}` : ` | ${record.status}`;
}

export function toolFailureText(record) {
  return [record?.reason_code, record?.failure_reason].filter(Boolean).join(': ');
}

function resultDetail(record) {
  const values = [record.status];
  if (Number.isFinite(record.elapsed_ms)) values.push(`${Math.round(record.elapsed_ms)} ms`);
  if (record.effect_certainty) values.push(`effect ${record.effect_certainty}`);
  const failure = toolFailureText(record); if (failure) values.push(failure);
  return values.join(' | ');
}

function toolSymbol(status) {
  if (!status) return '-';
  if (status === 'running') return '+';
  if (status === 'succeeded') return '\u2713';
  return 'X';
}
