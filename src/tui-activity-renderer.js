// SPDX-License-Identifier: Apache-2.0

export function compactActivityRows(records) {
  const calls = new Map();
  for (const record of records) {
    if (record.type !== 'tool_status') continue;
    const id = record.tool_request_id ?? record.provider_call_id ?? `activity:${calls.size}`;
    const item = calls.get(id) ?? { tool: record.tool ?? 'tool request', target: null, result: null };
    item.tool = record.tool;
    item.target = record.target ?? item.target;
    item.result = record;
    calls.set(id, item);
  }
  return [...calls.values()].map((item) => {
    const timing = Number.isFinite(item.result?.elapsed_ms) ? ` | ${Math.round(item.result.elapsed_ms)} ms` : '';
    return `  ${toolSymbol(item.result?.status)} ${item.tool}${item.target ? ` (${item.target})` : ''}${timing}`;
  });
}

function toolSymbol(status) {
  if (!status) return '-';
  if (status === 'running') return '+';
  if (status === 'succeeded') return 'OK';
  return 'X';
}
