// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';

export const REASONING_EFFORTS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

export function validateReasoningEffort(value) {
  return validateOptional(value, (candidate) => typeof candidate === 'string' && REASONING_EFFORTS.includes(candidate),
    'provider_reasoning_effort_invalid', 'reasoning effort is not supported');
}

export function validateEnableThinking(value) {
  return validateOptional(value, (candidate) => typeof candidate === 'boolean',
    'provider_thinking_mode_invalid', 'enable_thinking must be true, false, or unset');
}

export function routeReasoningFields(route) {
  return {
    ...(present(route.reasoningEffort) ? { reasoningEffort: route.reasoningEffort } : {}),
    ...(present(route.enableThinking) ? { enableThinking: route.enableThinking } : {}),
  };
}

export function providerReasoningControls(request) {
  if (request.reasoningMode !== undefined && request.reasoningMode !== 'off') {
    throw new ContractError('provider_reasoning_mode_invalid', 'provider reasoning mode is invalid');
  }
  if (request.reasoningMode === 'off') {
    // OpenAI-compatible hosts do not agree on which control disables hidden
    // reasoning. LM Studio's Qwen path requires both controls; the template
    // flag alone can be ignored by the serving layer.
    return { reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false } };
  }
  const effort = validateReasoningEffort(request.reasoningEffort);
  const thinking = validateEnableThinking(request.enableThinking);
  return {
    ...(present(effort) && !binaryThinkingModel(request.model) ? { reasoning_effort: effort } : {}),
    ...(present(thinking) ? { chat_template_kwargs: { enable_thinking: thinking } } : {}),
  };
}

// Qwen-compatible chat templates expose binary thinking rather than the
// OpenAI reasoning-effort scale. Some hosts promote an unsupported value such
// as "low" to fully enabled reasoning, so leave the model at its native default
// unless the route explicitly selects the supported enable_thinking control.
function binaryThinkingModel(model) {
  return typeof model === 'string' && /(?:^|[\/@._-])qwen/iu.test(model);
}

function validateOptional(value, predicate, code, message) {
  if (!present(value)) return null;
  if (!predicate(value)) throw new ContractError(code, message);
  return value;
}

function present(value) {
  return value !== null && value !== undefined;
}
