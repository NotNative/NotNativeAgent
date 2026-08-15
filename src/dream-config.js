// SPDX-License-Identifier: Apache-2.0
import { boundedInteger } from './config-bounds.js';

const DREAM_LIMITS = Object.freeze({
  idleMs: Object.freeze({ input: 'idle_ms', fallback: 45_000, minimum: 5_000, maximum: 3_600_000 }),
  interStageMs: Object.freeze({ input: 'inter_stage_ms', fallback: 5_000, minimum: 1_000, maximum: 300_000 }),
  inferenceIdleMs: Object.freeze({ input: 'inference_idle_ms', fallback: 120_000, minimum: 10_000, maximum: 3_600_000 }),
  hygieneIdleMs: Object.freeze({ input: 'hygiene_idle_ms', fallback: 300_000, minimum: 30_000, maximum: 7_200_000 }),
  retentionDays: Object.freeze({ input: 'retention_days', fallback: 30, minimum: 1, maximum: 365 }),
});

export function validateDream(value, executionManifest) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const limits = Object.fromEntries(Object.entries(DREAM_LIMITS).map(([output, rule]) => [
    output, boundedInteger(input[rule.input], rule.fallback, rule.minimum, rule.maximum),
  ]));
  return {
    // Idle maintenance is an opt-out standalone feature; authenticated hosted execution always disables it.
    enabled: executionManifest ? false : input.enabled !== false,
    ...limits,
  };
}
