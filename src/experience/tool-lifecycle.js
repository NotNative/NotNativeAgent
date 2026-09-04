// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';

export const INTERMEDIATE_TOOL_STATUSES = Object.freeze([
  'review_pending', 'approved', 'running',
]);

const INTERMEDIATE = new Set(INTERMEDIATE_TOOL_STATUSES);
const TERMINAL = new Set([
  'succeeded', 'failed', 'completed_nonzero', 'cancelled', 'timed_out', 'unknown_effect',
  'invalid', 'invalid_request', 'denied', 'denied_with_guidance', 'hard_denied',
  'escalation_pending', 'duplicate_ignored',
]);

export function isIntermediateToolStatus(status) { return INTERMEDIATE.has(status); }
export function isTerminalToolStatus(status) {
  return TERMINAL.has(status);
}

export function toolStatusIdentity(record) {
  return record?.tool_request_id ?? record?.provider_call_id ?? null;
}

export function latestToolStatusIndexes(records) {
  if (!Array.isArray(records)) throw new ContractError('transcript_invalid', 'tool status records must be an array');
  const latest = new Map();
  for (let index = 0; index < records.length; index += 1) {
    if (records[index]?.type !== 'tool_status') continue;
    const identity = toolStatusIdentity(records[index]);
    if (identity) latest.set(identity, index);
  }
  return latest;
}
