// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

export const REASONING_EFFORTS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

export function validateReasoningEffort(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !REASONING_EFFORTS.includes(value)) {
    throw new ContractError('provider_reasoning_effort_invalid', 'reasoning effort is not supported');
  }
  return value;
}

export function validateEnableThinking(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') {
    throw new ContractError('provider_thinking_mode_invalid', 'enable_thinking must be true, false, or unset');
  }
  return value;
}

export function routeReasoningFields(route) {
  return {
    ...(route.reasoningEffort == null ? {} : { reasoningEffort: route.reasoningEffort }),
    ...(route.enableThinking == null ? {} : { enableThinking: route.enableThinking }),
  };
}

export function providerReasoningControls(request) {
  if (request.reasoningMode !== undefined && request.reasoningMode !== 'off') {
    throw new ContractError('provider_reasoning_mode_invalid', 'provider reasoning mode is invalid');
  }
  if (request.reasoningMode === 'off') {
    return { reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false } };
  }
  const effort = validateReasoningEffort(request.reasoningEffort);
  const thinking = validateEnableThinking(request.enableThinking);
  return {
    ...(effort == null ? {} : { reasoning_effort: effort }),
    ...(thinking == null ? {} : { chat_template_kwargs: { enable_thinking: thinking } }),
  };
}
