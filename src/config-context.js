// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { boundedInteger, boundedNumber } from './config-bounds.js';

// The legacy four-tier policy allocates most of the interval evenly to the three compression tiers,
// leaving the final seventh as a short warning band immediately before full compaction.
const LEVEL_2_SPAN_FRACTION = 3 / 7;
const LEVEL_3_SPAN_FRACTION = 6 / 7;

export function resolveContextLimits(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new ContractError('context_configuration_invalid', 'context configuration must be an object');
  }
  const maxContextBytes = boundedInteger(manifest.context_limit_bytes, 2_097_152, 65_536, 16_777_216);
  const contextCompressionThreshold = boundedNumber(manifest.context_compression_threshold, 0.40, 0.20, 0.90);
  const contextCompactionThreshold = boundedNumber(manifest.context_compaction_threshold, 0.75, 0.30, 0.99);
  const span = contextCompactionThreshold - contextCompressionThreshold;
  const contextCompressionLevel2Threshold = boundedNumber(
    manifest.context_compression_level_2_threshold,
    contextCompressionThreshold + (span * LEVEL_2_SPAN_FRACTION), 0.20, 0.99,
  );
  const contextCompressionLevel3Threshold = boundedNumber(
    manifest.context_compression_level_3_threshold,
    contextCompressionThreshold + (span * LEVEL_3_SPAN_FRACTION), 0.20, 0.99,
  );
  if (!(contextCompressionThreshold < contextCompressionLevel2Threshold
    && contextCompressionLevel2Threshold < contextCompressionLevel3Threshold
    && contextCompressionLevel3Threshold < contextCompactionThreshold)) {
    throw new ContractError('context_thresholds_invalid',
      'context thresholds must increase in order: level 1, level 2, level 3, full compaction');
  }
  return {
    maxContextBytes, contextCompressionThreshold, contextCompressionLevel2Threshold,
    contextCompressionLevel3Threshold, contextCompactionThreshold,
  };
}
