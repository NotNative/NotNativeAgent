// SPDX-License-Identifier: Apache-2.0
import { resolveConfigurationScalar as scalar } from './configuration-rules.js';

const DREAM_LIMITS = Object.freeze({
  idleMs: 'idle_ms', interStageMs: 'inter_stage_ms', inferenceIdleMs: 'inference_idle_ms',
  hygieneIdleMs: 'hygiene_idle_ms', retentionDays: 'retention_days',
});

export function validateDream(value, executionManifest) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const limits = Object.fromEntries(Object.entries(DREAM_LIMITS).map(([output, key]) => [
    output, scalar(`dream.${key}`, input[key]),
  ]));
  return {
    // Idle maintenance is an opt-out standalone feature; authenticated hosted execution always disables it.
    enabled: executionManifest ? false : input.enabled !== false,
    ...limits,
  };
}
