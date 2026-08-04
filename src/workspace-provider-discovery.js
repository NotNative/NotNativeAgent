// SPDX-License-Identifier: Apache-2.0
import { withProvider } from './route-configuration.js';
import { boundedProviderCapabilities } from './provider-capabilities.js';

export async function discoverWorkspaceProviderModels(workspace, input) {
  let probeId = 'nna-provider-setup';
  for (let suffix = 2; workspace.config.providerProfiles[probeId]; suffix += 1) probeId = `nna-provider-setup-${suffix}`;
  const profile = withProvider(workspace.config, {
    id: probeId, displayName: input.displayName ?? probeId, endpoint: input.endpoint,
    model: input.model || 'nna-model-discovery', credentialEnv: input.credentialEnv || undefined,
  }).config.providerProfiles[probeId];
  const provider = workspace.activeEngine().router.providerForProfile(profile);
  if (typeof provider.capabilities !== 'function') return { ready: true, models: input.model ? [input.model] : [] };
  const capabilities = await boundedProviderCapabilities(provider, workspace.options.providerCapabilityDeadlineMs ?? 5_000);
  return {
    ready: true,
    models: Array.isArray(capabilities?.models)
      ? capabilities.models.filter((item) => typeof item === 'string' && item.length > 0 && item.length <= 256).slice(0, 4096)
      : [],
  };
}
