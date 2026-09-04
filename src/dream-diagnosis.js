// SPDX-License-Identifier: Apache-2.0

const QUARANTINE_STATUSES = Object.freeze(['unknown_effect', 'timed_out', 'failed', 'cancelled', 'denied']);
const QUARANTINE = new Set(QUARANTINE_STATUSES);
const MINIMUM_REPEATED_REASON_COUNT = 3;
const MAX_ISSUES = 16;

export function diagnoseDreamEvidence(rows) {
  const turns = new Map(), reasons = new Map(), statuses = new Map();
  let invalidRows = 0;
  if (!Array.isArray(rows)) return diagnosis(turns, statuses, reasons, 1);
  for (const row of rows) {
    if (!row || typeof row !== 'object' || typeof row.turn_id !== 'string' || !row.turn_id
      || typeof row.status !== 'string' || !row.status) { invalidRows += 1; continue; }
    if (!turns.has(row.turn_id)) turns.set(row.turn_id, new Set());
    turns.get(row.turn_id).add(row.status);
    statuses.set(row.status, (statuses.get(row.status) ?? 0) + 1);
    if (QUARANTINE.has(row.status) && typeof row.reason_code === 'string' && row.reason_code) {
      if (!reasons.has(row.reason_code)) reasons.set(row.reason_code, new Set());
      reasons.get(row.reason_code).add(row.turn_id);
    }
  }
  return diagnosis(turns, statuses, reasons, invalidRows);
}

function diagnosis(turns, statuses, reasons, invalidRows) {
  const quarantined = [...turns.values()].filter((values) => [...values].some((value) => QUARANTINE.has(value))).length;
  const issues = issueSummary(statuses, reasons);
  if (invalidRows > 0) issues.unshift(Object.freeze({ code: 'invalid_evidence_rows', count: invalidRows, action: 'inspect malformed evidence before learning' }));
  return Object.freeze({
    status: issues.length === 0 ? 'clean' : 'attention',
    turns: turns.size, eligible_turns: Math.max(0, turns.size - quarantined),
    quarantined_turns: quarantined, issues: Object.freeze(issues.slice(0, MAX_ISSUES)),
  });
}

function issueSummary(statuses, reasons) {
  const issues = [];
  for (const status of QUARANTINE_STATUSES) {
    const count = statuses.get(status) ?? 0;
    if (count > 0) issues.push(Object.freeze({ code: `terminal_${status}`, count, action: action(status) }));
  }
  for (const [reason, count] of [...reasons].map(([key, turns]) => [key, turns.size])
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))) {
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
