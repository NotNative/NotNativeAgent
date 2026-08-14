// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';

export async function boundedProviderCapabilities(provider, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const operation = Promise.resolve().then(() => provider.capabilities(controller.signal));
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ContractError('provider_capabilities_timeout', 'provider capability discovery exceeded its deadline', true));
    }, timeoutMs);
  });
  try { return boundedCapabilityRecord(await Promise.race([operation, timeout])); }
  finally {
    clearTimeout(timer);
    controller.abort();
    operation.catch(() => undefined);
  }
}

function boundedCapabilityRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContractError('provider_capabilities_invalid', 'provider capabilities must be an object');
  }
  const models = Array.isArray(value.models) ? value.models.slice(0, 4096)
    .filter((item) => typeof item === 'string' && item.length > 0 && item.length <= 256) : [];
  const result = { models: Object.freeze(models) };
  for (const key of ['tools', 'images', 'structuredOutput', 'usage', 'cancellation']) {
    if ([true, false, 'unknown'].includes(value[key])) result[key] = value[key];
  }
  for (const key of ['contextLimitBytes', 'contextLimitTokens', 'outputLimitTokens']) {
    if ((Number.isInteger(value[key]) && value[key] > 0) || value[key] === 'unknown') result[key] = value[key];
  }
  if (typeof value.model === 'string' && value.model.length <= 256) result.model = value.model;
  return Object.freeze(result);
}
