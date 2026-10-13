// SPDX-License-Identifier: Apache-2.0
export const QUEUE_TIMING = {
  quietMs: 500, // turn-boundary burst coalescing (§D.3)
  verifyBackoffMs: 2000, // failed idleness fetch re-arm (§D.3.4)
  abortHoldMs: 2000, // a stop is not immediately followed by the next prompt
  backoffBaseMs: 2000, // failure backoff base × 2^n, cap 60 s (§D.3.8)
  backoffMaxMs: 60_000,
  holdDefaultMs: 5 * 60_000, // auto-review hold default (§D.4)
  holdMaxMs: 10 * 60_000,
};

export type QueueTiming = typeof QUEUE_TIMING;
export type QueueTimingOverride = Partial<QueueTiming>;
