// SPDX-License-Identifier: Apache-2.0

export const INTERMEDIATE_TOOL_STATUSES = Object.freeze([
  'review_pending', 'approved', 'running',
]);

const INTERMEDIATE = new Set(INTERMEDIATE_TOOL_STATUSES);

export function isIntermediateToolStatus(status) { return INTERMEDIATE.has(status); }
export function isTerminalToolStatus(status) {
  return typeof status === 'string' && status.length > 0 && !isIntermediateToolStatus(status);
}

export function toolStatusIdentity(record) {
  return record?.tool_request_id ?? record?.provider_call_id ?? null;
}

export function latestToolStatusIndexes(records) {
  const latest = new Map();
  for (let index = 0; index < records.length; index += 1) {
    if (records[index]?.type !== 'tool_status') continue;
    const identity = toolStatusIdentity(records[index]);
    if (identity) latest.set(identity, index);
  }
  return latest;
}
