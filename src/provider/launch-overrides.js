// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { withPrimaryRoute, withProvider } from './route-configuration.js';

const MAX_LAUNCH_OVERRIDE_ATTEMPTS = 1_000;

export function applyLaunchProviderOverrides(config, options = {}) {
  if (!config?.routes?.primary || !config.providerProfiles || typeof config.providerProfiles !== 'object') {
    throw new ContractError('provider_configuration_invalid', 'launch overrides require a resolved provider configuration');
  }
  const profileSelector = options.providerProfile;
  const endpoint = options.providerEndpoint;
  const model = options.model;
  const credentialEnv = options.providerCredentialEnv;
  if (!profileSelector && !endpoint && !model && !credentialEnv) return config;
  if (profileSelector && endpoint) {
    throw new ContractError('provider_override_conflict', '--provider-profile and --provider-endpoint are mutually exclusive');
  }
  if (endpoint && !model) {
    throw new ContractError('provider_model_required', '--provider-endpoint currently requires --model; no catalog entry is selected implicitly');
  }
  const profileId = profileSelector ? resolveProfileId(config.providerProfiles, profileSelector) : config.routes.primary.providerId;
  const selected = config.providerProfiles[profileId];
  if (!selected && !endpoint) throw new ContractError('provider_missing', `provider ${profileSelector ?? profileId} is not configured`);
  if (!endpoint && !credentialEnv) return tagged(withPrimaryRoute(config, selected.id, model ?? selected.model).config, options);
  const id = availableId(config.providerProfiles);
  const added = withProvider(config, {
    id, displayName: `Temporary launch route (${selected?.displayName ?? endpoint})`,
    endpoint: endpoint ?? selected.endpoint, model: model ?? selected.model,
    credentialEnv: credentialEnv ?? selected.credentialEnv,
  }).config;
  return tagged(withPrimaryRoute(added, id, model ?? selected.model).config, options);
}

function resolveProfileId(profiles, selector) {
  if (profiles[selector]) return selector;
  const values = Object.values(profiles);
  const exact = values.filter((profile) => profile.displayName === selector);
  const exactId = uniqueMatch(exact, selector);
  if (exactId) return exactId;
  const folded = selector.toLocaleLowerCase('en-US');
  const insensitive = values
    .filter((profile) => profile.displayName.toLocaleLowerCase('en-US') === folded);
  const insensitiveId = uniqueMatch(insensitive, selector);
  if (insensitiveId) return insensitiveId;
  throw new ContractError('provider_missing', `provider profile ${selector} is not configured`);
}

function uniqueMatch(matches, selector) {
  if (matches.length > 1) throw ambiguous(selector);
  return matches[0]?.id ?? null;
}

function ambiguous(selector) {
  return new ContractError('provider_profile_ambiguous', `provider profile label ${selector} matches more than one saved profile`);
}

function tagged(config, options) {
  return Object.freeze({
    ...config,
    launchOverrides: Object.freeze({
      ephemeral: true, source: 'command_line', providerProfile: options.providerProfile ?? null,
      endpoint: options.providerEndpoint ?? null, model: options.model ?? null,
      credentialReference: Boolean(options.providerCredentialEnv),
    }),
  });
}

function availableId(profiles) {
  for (let index = 0; index < MAX_LAUNCH_OVERRIDE_ATTEMPTS; index += 1) {
    const id = index === 0 ? 'launch-override' : `launch-override-${index}`;
    if (!profiles[id]) return id;
  }
  throw new ContractError('provider_limit', 'no temporary launch provider identifier is available');
}
