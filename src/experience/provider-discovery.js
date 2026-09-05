// SPDX-License-Identifier: Apache-2.0
import { withProvider } from '../provider/route-configuration.js';
import { boundedProviderCapabilities } from '../provider/capabilities.js';
import { ContractError } from '../ids.js';
import { testProviderProfile } from './provider-test.js';

const DEFAULT_CAPABILITY_DEADLINE_MS = 5_000;
const MAX_DISCOVERED_MODEL_LENGTH = 256;
const MAX_DISCOVERED_MODELS = 4096;

export async function discoverWorkspaceProviderModels(workspace, input) {
  if (!workspace?.config?.providerProfiles || typeof workspace.activeEngine !== 'function'
    || !input || typeof input !== 'object' || typeof input.endpoint !== 'string' || input.endpoint.length === 0) {
    throw new ContractError('provider_discovery_invalid', 'provider discovery requires a workspace and endpoint');
  }
  const { profile, provider } = temporaryProvider(workspace, input);
  if (typeof provider.capabilities !== 'function') return { ready: true, models: input.model ? [input.model] : [] };
  const capabilities = await boundedProviderCapabilities(
    provider, workspace.options?.providerCapabilityDeadlineMs ?? DEFAULT_CAPABILITY_DEADLINE_MS,
  );
  return {
    ready: true,
    models: Array.isArray(capabilities?.models)
      ? capabilities.models.filter((item) => typeof item === 'string' && item.length > 0
        && item.length <= MAX_DISCOVERED_MODEL_LENGTH).slice(0, MAX_DISCOVERED_MODELS)
      : [],
  };
}

export async function qualifyWorkspaceProvider(workspace, input) {
  const { profile, provider } = temporaryProvider(workspace, input);
  return testProviderProfile(profile, provider, workspace.options);
}

function temporaryProvider(workspace, input) {
  let probeId = 'nna-provider-setup';
  for (let suffix = 2; workspace.config.providerProfiles[probeId]; suffix += 1) probeId = `nna-provider-setup-${suffix}`;
  const profile = withProvider(workspace.config, {
    id: probeId, displayName: input.displayName ?? probeId, endpoint: input.endpoint,
    model: input.model || 'nna-model-discovery', credential: input.credential ?? undefined,
    credentialEnv: input.credentialEnv || undefined,
  }).config.providerProfiles[probeId];
  const provider = workspace.activeEngine()?.router?.providerForProfile(profile);
  if (!provider || typeof provider !== 'object') {
    throw new ContractError('provider_discovery_unavailable', 'provider discovery route is unavailable');
  }
  return { profile, provider };
}
