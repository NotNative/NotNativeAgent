// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { withPrimaryRoute, withProvider } from './route-configuration.js';

export function applyLaunchProviderOverrides(config, options = {}) {
  const profileId = options.providerProfile, endpoint = options.providerEndpoint;
  const model = options.model, credentialEnv = options.providerCredentialEnv;
  if (!profileId && !endpoint && !model && !credentialEnv) return config;
  if (profileId && endpoint) {
    throw new ContractError('provider_override_conflict', '--provider-profile and --provider-endpoint are mutually exclusive');
  }
  if (endpoint && !model) {
    throw new ContractError('provider_model_required', '--provider-endpoint currently requires --model; no catalog entry is selected implicitly');
  }
  const selected = profileId ? config.providerProfiles[profileId] : config.providerProfiles[config.routes.primary.providerId];
  if (!selected && !endpoint) throw new ContractError('provider_missing', `provider ${profileId ?? config.routes.primary.providerId} is not configured`);
  if (!endpoint && !credentialEnv) return withPrimaryRoute(config, selected.id, model ?? selected.model).config;
  const id = availableId(config.providerProfiles);
  const added = withProvider(config, {
    id, displayName: `Temporary launch route (${selected?.displayName ?? endpoint})`,
    endpoint: endpoint ?? selected.endpoint, model: model ?? selected.model,
    credentialEnv: credentialEnv ?? selected.credentialEnv,
  }).config;
  return withPrimaryRoute(added, id, model ?? selected.model).config;
}

function availableId(profiles) {
  for (let index = 0; index < 1000; index += 1) {
    const id = index === 0 ? 'launch-override' : `launch-override-${index}`;
    if (!profiles[id]) return id;
  }
  throw new ContractError('provider_limit', 'no temporary launch provider identifier is available');
}
