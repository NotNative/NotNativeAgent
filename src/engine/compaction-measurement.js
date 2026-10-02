// SPDX-License-Identifier: Apache-2.0
import { providerRequest } from './runtime-helpers.js';

export function measureCompactionInput(engine, route, context, active, budget) {
  const request = providerRequest(engine, route, context, {
    outputReserveTokens: budget.outputReserveTokens,
    conversationIntent: active.conversationIntent, approvedProposal: active.approvedProposal,
  });
  return engine.reliability.providerEnvelope(request, context, { outputReserveTokens: budget.outputReserveTokens });
}

export function compactionBudgetDetail(budget, retryScale = 1) {
  const byteCeiling = Math.floor(budget.hardLimitBytes * (budget.compactionThreshold ?? 0.75) * retryScale);
  const tokenByteCeiling = budget.scaledTokens * 3;
  return {
    measurement: 'estimated', measurement_basis: 'complete_provider_input',
    context_window_tokens: budget.windowTokens, effective_input_tokens: budget.effectiveInputTokens,
    output_reserve_tokens: budget.outputReserveTokens, source: budget.source,
    hard_limit_bytes: budget.hardLimitBytes, threshold_bytes: budget.thresholdBytes,
    admissible_ceiling_tokens: budget.scaledTokens, context_estimate_scale: budget.estimateScale ?? 1,
    retry_scale: retryScale,
    binding_ceiling: byteCeiling < tokenByteCeiling ? 'configured_bytes' : 'token_budget',
  };
}
