// SPDX-License-Identifier: Apache-2.0
/**
 * Wire-visible harness names, server side. MIRROR of packages/ui/src/lib/nnd/constants.ts
 * (the node runtime graph must not import the Vite-flavored UI module) — the NNA
 * naming pass edits BOTH files together. Doc 02 §9 + NOTES/02 D13/D15.
 */
export const HARNESS_NAME = 'NotNativeAgent';
// Why: the mock's /global/health version mirrors the REAL contract shape —
// NNA answers with its product version (YYYYMMDD-N, src/product.js VERSION),
// never a semver. A mock-specific '0.1.0-mock' taught consumers to expect a
// shape real NNA never returns (uniformity audit follow-up). The value is
// clearly marked mock-only so it can never be confused with a real build id.
export const HARNESS_VERSION = '00000000-0-mock';

/** HP-4 / doc 02 §3.5: directory scoping transports. */
export const DIRECTORY_HEADER = 'x-nnd-directory';
export const DIRECTORY_ENCODING_HEADER = 'x-nnd-directory-encoding';

/** P-01 (NNA adapter contract, not the mock): stdout readiness line. */
export const HARNESS_LISTENING_LINE = 'notnativeagent server listening on';

/** Control-stream synthetic family (doc 02 §5.4, renamed per DECISIONS). */
export const CONTROL_EVENT_PREFIX = 'notnative:';
export const CONTROL_EVENTS = {
  heartbeat: 'notnative:heartbeat',
  eventStreamReady: 'notnative:event-stream-ready',
  sessionStatus: 'notnative:session-status',
  sessionActivity: 'notnative:session-activity',
  notification: 'notnative:notification',
  // §D.5 message-queue fanout (E-09-1: NND brand on the doc-12 channel)
  messageQueueUpdated: 'notnative:message-queue.updated',
  // §C.10 scheduled-task run events (same NND brand rule as E-09-1)
  scheduledTaskRan: 'notnative:scheduled-task-ran',
  // P9-6b orchestration fanout
  sessionCreated: 'notnative:session-created',
  // Agent memory storage changed through the managed tool or panel routes.
  agentMemoryChanged: 'notnative:agent-memory-changed',
} as const;

/**
 * Managed-harness env names (doc 02 §2.1 renamed; consumed by the future
 * nna.ts lifecycle, listed here as the agreed contract).
 * NNA_PORT / NNA_HOST / NNA_SKIP_START / NNA_BINARY / NNA_SERVER_PASSWORD /
 * NNA_SERVER_USERNAME (default 'nna') / NNA_HEALTH_TIMEOUT_MS (5000) /
 * NNA_HEALTH_INTERVAL_MS (15000) / NNA_HEALTH_CONSECUTIVE_FAILURES (20) /
 * NNA_HEALTH_CACHE_MS (750)
 */
