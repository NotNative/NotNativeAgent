// SPDX-License-Identifier: Apache-2.0

const QUARANTINE_STATUSES = Object.freeze(['unknown_effect', 'timed_out', 'failed', 'cancelled', 'denied']);
const QUARANTINE = new Set(QUARANTINE_STATUSES);
const MINIMUM_REPEATED_REASON_COUNT = 3;
const MAX_ISSUES = 16;

export function diagnoseDreamEvidence(rows) {
  const turns = new Map(), reasons = new Map(), statuses = new Map();
  if (!Array.isArray(rows)) return diagnosis(turns, statuses, reasons);
  for (const row of rows) {
    if (!row || typeof row !== 'object' || typeof row.turn_id !== 'string' || !row.turn_id
      || typeof row.status !== 'string' || !row.status) continue;
    if (!turns.has(row.turn_id)) turns.set(row.turn_id, new Set());
    turns.get(row.turn_id).add(row.status);
    statuses.set(row.status, (statuses.get(row.status) ?? 0) + 1);
    if (typeof row.reason_code === 'string' && row.reason_code) reasons.set(row.reason_code, (reasons.get(row.reason_code) ?? 0) + 1);
  }
  return diagnosis(turns, statuses, reasons);
}

function diagnosis(turns, statuses, reasons) {
  const quarantined = [...turns.values()].filter((values) => [...values].some((value) => QUARANTINE.has(value))).length;
  const issues = issueSummary(statuses, reasons);
  return Object.freeze({
    status: issues.length === 0 ? 'clean' : 'attention',
    turns: turns.size, eligible_turns: Math.max(0, turns.size - quarantined),
    quarantined_turns: quarantined, issues: Object.freeze(issues),
  });
}

function issueSummary(statuses, reasons) {
  const issues = [];
  for (const status of QUARANTINE_STATUSES) {
    const count = statuses.get(status) ?? 0;
    if (count > 0) issues.push(Object.freeze({ code: `terminal_${status}`, count, action: action(status) }));
  }
  for (const [reason, count] of [...reasons].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))) {
    if (count < MINIMUM_REPEATED_REASON_COUNT) continue;
    issues.push(Object.freeze({ code: 'repeated_reason', reason, count, action: 'inspect the affected turn before learning from it' }));
    if (issues.length >= MAX_ISSUES) break;
  }
  return issues;
}

function action(status) {
  if (status === 'unknown_effect') return 'verify side effects before retrying or learning';
  if (status === 'timed_out') return 'inspect provider or tool latency and retry evidence';
  if (status === 'denied') return 'preserve the authority decision; do not promote the attempted effect';
  if (status === 'cancelled') return 'treat the episode as incomplete';
  return 'inspect bounded turn diagnostics before promotion';
}
