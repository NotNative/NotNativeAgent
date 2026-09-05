// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';

const MAX_CAPABILITY_MODELS = 4096;
const MAX_MODEL_ID_LENGTH = 256;
const BOOLEAN_CAPABILITY_KEYS = Object.freeze(['tools', 'images', 'structuredOutput', 'usage', 'cancellation']);
const LIMIT_CAPABILITY_KEYS = Object.freeze(['contextLimitBytes', 'contextLimitTokens', 'outputLimitTokens']);

export async function boundedProviderCapabilities(provider, timeoutMs) {
  return boundedProviderOperation(
    (signal) => provider.capabilities(signal), timeoutMs,
    'provider_capabilities_timeout', 'provider capability discovery exceeded its deadline',
    boundedCapabilityRecord,
  );
}

export async function boundedProviderToolCallCompatibility(provider, timeoutMs) {
  return boundedProviderOperation(
    (signal) => provider.toolCallCompatibility(signal), timeoutMs,
    'provider_tool_call_test_timeout', 'provider tool-call compatibility test exceeded its deadline',
    boundedToolCallCompatibility,
  );
}

async function boundedProviderOperation(operationFactory, timeoutMs, code, message, validate) {
  const controller = new AbortController();
  let timer;
  const operation = Promise.resolve().then(() => operationFactory(controller.signal));
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ContractError(code, message, true));
    }, timeoutMs);
  });
  try { return validate(await Promise.race([operation, timeout])); }
  finally {
    clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort();
    // When the timeout wins, observe a provider that rejects later without replacing the timeout result.
    operation.catch(() => undefined);
  }
}

function boundedToolCallCompatibility(value) {
  if (!value || typeof value !== 'object' || !['single', 'batch'].includes(value.supportedMode)) {
    throw new ContractError('provider_tool_call_test_invalid', 'provider tool-call compatibility result is invalid');
  }
  return Object.freeze({ supportedMode: value.supportedMode });
}

function boundedCapabilityRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContractError('provider_capabilities_invalid', 'provider capabilities must be an object');
  }
  const models = Array.isArray(value.models) ? value.models.slice(0, MAX_CAPABILITY_MODELS)
    .filter((item) => typeof item === 'string' && item.length > 0 && item.length <= MAX_MODEL_ID_LENGTH) : [];
  const result = { models: Object.freeze(models) };
  for (const key of BOOLEAN_CAPABILITY_KEYS) {
    if (Object.hasOwn(value, key) && [true, false, 'unknown'].includes(value[key])) result[key] = value[key];
  }
  for (const key of LIMIT_CAPABILITY_KEYS) {
    if (Object.hasOwn(value, key)
      && ((Number.isInteger(value[key]) && value[key] > 0) || value[key] === 'unknown')) result[key] = value[key];
  }
  if (typeof value.model === 'string' && value.model.length > 0 && value.model.length <= MAX_MODEL_ID_LENGTH) result.model = value.model;
  return Object.freeze(result);
}
