// SPDX-License-Identifier: Apache-2.0

// Invariant: the host and worker use the same terminal vocabulary for open spans.
export const TERMINAL_TELEMETRY_STATUSES = Object.freeze([
  'succeeded', 'failed', 'cancelled', 'timed_out', 'denied', 'skipped', 'superseded',
  'unknown_effect', 'blocked', 'incomplete', 'needs_input', 'limit_reached',
  'completed_nonzero', 'invalid_request', 'invalid', 'escalation_pending', 'unknown',
]);
