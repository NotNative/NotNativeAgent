// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { resolveConfigurationScalar as scalar } from './configuration-rules.js';

// The legacy four-tier policy allocates most of the interval evenly to the three compression tiers,
// leaving the final seventh as a short warning band immediately before full compaction.
const LEVEL_2_SPAN_FRACTION = 3 / 7;
const LEVEL_3_SPAN_FRACTION = 6 / 7;

export function resolveContextLimits(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new ContractError('context_configuration_invalid', 'context configuration must be an object');
  }
  const maxContextBytes = scalar('context_limit_bytes', manifest.context_limit_bytes);
  const contextCompressionThreshold = scalar('context_compression_threshold', manifest.context_compression_threshold);
  const contextCompactionThreshold = scalar('context_compaction_threshold', manifest.context_compaction_threshold);
  const span = contextCompactionThreshold - contextCompressionThreshold;
  const contextCompressionLevel2Threshold = scalar(
    'context_compression_level_2_threshold', manifest.context_compression_level_2_threshold,
    contextCompressionThreshold + (span * LEVEL_2_SPAN_FRACTION),
  );
  const contextCompressionLevel3Threshold = scalar(
    'context_compression_level_3_threshold', manifest.context_compression_level_3_threshold,
    contextCompressionThreshold + (span * LEVEL_3_SPAN_FRACTION),
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
