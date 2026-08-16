// SPDX-License-Identifier: Apache-2.0

const BATCHING_THRESHOLD = 100;
const MINIMUM_HEADROOM = 10;

export function retentionCompactionTarget(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1) return limit;
  if (limit < BATCHING_THRESHOLD) return limit;
  const headroom = Math.max(MINIMUM_HEADROOM, Math.floor(limit / 10));
  return Math.max(1, limit - headroom);
}
