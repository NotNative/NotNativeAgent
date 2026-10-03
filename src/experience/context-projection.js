// SPDX-License-Identifier: Apache-2.0
export function applyContextStatus(session, event) {
  session.contextBytes = event.bytes;
  session.contextLimitBytes = event.limit_bytes;
  session.contextTokens = event.estimated_tokens;
  session.rawContextTokens = event.raw_estimated_tokens;
  session.contextLimitTokens = event.limit_tokens;
  session.contextThresholdTokens = event.compaction_threshold_tokens;
  session.contextCompressionThresholdTokens = event.compression_threshold_tokens;
  session.contextCompressionLevel2ThresholdTokens = event.compression_level_2_threshold_tokens;
  session.contextCompressionLevel3ThresholdTokens = event.compression_level_3_threshold_tokens;
  session.contextCompressionThreshold = event.compression_threshold;
  session.contextCompressionLevel2Threshold = event.compression_level_2_threshold;
  session.contextCompressionLevel3Threshold = event.compression_level_3_threshold;
  session.contextCompactionThreshold = event.compaction_threshold;
  session.contextOutputReserveTokens = event.output_reserve_tokens;
  session.contextParallelCapacity = event.parallel_capacity;
  session.contextMeasurement = event.measurement;
  session.contextSource = event.source;
}
