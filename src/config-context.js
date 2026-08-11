// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { boundedInteger, boundedNumber } from './config-bounds.js';

export function resolveContextLimits(manifest) {
  const maxContextBytes = boundedInteger(manifest.context_limit_bytes, 2_097_152, 65_536, 16_777_216);
  const contextCompressionThreshold = boundedNumber(manifest.context_compression_threshold, 0.40, 0.20, 0.90);
  const contextCompactionThreshold = boundedNumber(manifest.context_compaction_threshold, 0.75, 0.30, 0.99);
  if (contextCompressionThreshold >= contextCompactionThreshold) {
    throw new ContractError('context_thresholds_invalid', 'context compression threshold must be lower than compaction threshold');
  }
  return { maxContextBytes, contextCompressionThreshold, contextCompactionThreshold };
}
