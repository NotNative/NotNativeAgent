// SPDX-License-Identifier: Apache-2.0
import { boundedInteger } from './config-bounds.js';

export function validateDream(value, executionManifest) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    enabled: executionManifest ? false : input.enabled !== false,
    idleMs: boundedInteger(input.idle_ms, 45_000, 5_000, 3_600_000),
    interStageMs: boundedInteger(input.inter_stage_ms, 5_000, 1_000, 300_000),
    inferenceIdleMs: boundedInteger(input.inference_idle_ms, 120_000, 10_000, 3_600_000),
    hygieneIdleMs: boundedInteger(input.hygiene_idle_ms, 300_000, 30_000, 7_200_000),
    retentionDays: boundedInteger(input.retention_days, 30, 1, 365),
  };
}
