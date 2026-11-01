// SPDX-License-Identifier: Apache-2.0

/** Milliseconds elapsed since a `process.hrtime.bigint()` mark. */
export function elapsedMs(started) {
  return Number(process.hrtime.bigint() - started) / 1_000_000;
}
