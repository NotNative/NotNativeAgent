// SPDX-License-Identifier: Apache-2.0
import {
  appendWebSearchProfile, loadWebSearchConfig, promoteWebSearchProfile, removeWebSearchProfile,
  replacePrimaryWebSearch, resetWebSearchConfig, saveWebSearchConfig,
} from '../web-search-config.js';
import { ContractError } from '../ids.js';

export async function webSearchStatus(state, test = false, profileId = null) {
  requireWebSearchState(state, { client: test });
  const config = await loadWebSearchConfig(state.path);
  let checked = null;
  if (test && config.enabled) {
    const profile = selectedProfile(config, profileId);
    checked = await state.client.test(profile.endpoint).catch((error) => ({
      ok: false, profile_id: profile.id, endpoint: profile.endpoint, error: error.code ?? error.message,
    }));
    if (checked.ok) checked = { ...checked, profile_id: profile.id };
  }
  return { config, test: checked };
}

export async function configureWebSearch(state, endpoint, managed = false) {
  requireWebSearchState(state, { client: true });
  const current = await loadWebSearchConfig(state.path);
  const candidate = replacePrimaryWebSearch(current, endpoint, managed);
  try {
    const checked = await state.client.test(candidate.profiles[0].endpoint);
    return { config: await saveWebSearchConfig(state.path, candidate), test: checked };
  } catch (error) {
    throw operationFailure(error, 'web_search_configuration_failed', 'WebSearch configuration could not be verified and saved');
  }
}

export async function addWebSearchProfile(state, displayName, endpoint) {
  requireWebSearchState(state, { client: true });
  const current = await loadWebSearchConfig(state.path);
  const candidate = appendWebSearchProfile(current, displayName, endpoint);
  const added = candidate.profiles.at(-1);
  try {
    const checked = await state.client.test(added.endpoint);
    return { config: await saveWebSearchConfig(state.path, candidate), test: { ...checked, profile_id: added.id } };
  } catch (error) {
    throw operationFailure(error, 'web_search_configuration_failed', 'WebSearch profile could not be verified and saved');
  }
}

export async function setPrimaryWebSearchProfile(state, profileId) {
  requireWebSearchState(state);
  const config = promoteWebSearchProfile(await loadWebSearchConfig(state.path), profileId);
  return { config: await saveWebSearchConfig(state.path, config), test: null };
}

export async function deleteWebSearchProfile(state, profileId) {
  requireWebSearchState(state);
  const config = removeWebSearchProfile(await loadWebSearchConfig(state.path), profileId);
  return { config: await saveWebSearchConfig(state.path, config), test: null, removed_profile_id: profileId };
}

export async function disableWebSearch(state) {
  return resetConfiguration(state, 'disabled');
}

export async function resetWebSearch(state) {
  return resetConfiguration(state, 'reset');
}

export async function deployWebSearch(state) {
  requireWebSearchState(state, { client: true, deployment: true });
  const deployment = await state.deployment.deploy();
  try { return { ...await configureWebSearch(state, deployment.endpoint, true), deployment }; }
  catch (error) {
    // The deployment may have existed before this command, so destructive rollback is unsafe.
    const failure = new ContractError(error?.code ?? 'web_search_configuration_failed',
      error?.message ?? 'WebSearch deployment configuration failed', error?.retryable === true, { cause: error });
    failure.partialDeployment = deployment;
    throw failure;
  }
}

export async function removeWebSearchDeployment(state) {
  requireWebSearchState(state, { deployment: true });
  const current = await loadWebSearchConfig(state.path);
  const deployment = await state.deployment.remove();
  const managed = current.profiles.filter((item) => item.managed).map((item) => item.id);
  let config = current;
  for (const id of managed) config = removeWebSearchProfile(config, id);
  if (managed.length > 0) config = await saveWebSearchConfig(state.path, config);
  return { config, test: null, deployment, removed: true };
}

function selectedProfile(config, profileId) {
  const profile = profileId
    ? config.profiles.find((item) => item.id === profileId) : config.profiles[0];
  if (!profile) throw new ContractError('web_search_profile_missing', `WebSearch profile does not exist: ${profileId ?? 'primary'}`);
  return profile;
}

export async function manageWebSearch(state, action) {
  requireWebSearchState(state, { deployment: true });
  try {
    if (action === 'start') await state.deployment.start();
    else if (action === 'stop') await state.deployment.stop();
    else throw new ContractError('web_search_action_invalid', 'unknown managed WebSearch action');
  } catch (error) {
    throw operationFailure(error, 'web_search_management_failed', `Managed WebSearch could not ${action}`);
  }
  if (action !== 'start') return webSearchStatus(state, false);
  const config = await loadWebSearchConfig(state.path);
  const managed = config.profiles.find((item) => item.managed);
  return webSearchStatus(state, true, managed?.id ?? null);
}

async function resetConfiguration(state, outcome) {
  requireWebSearchState(state);
  return { config: await resetWebSearchConfig(state.path), test: null, [outcome]: true };
}

function requireWebSearchState(state, requirements = {}) {
  if (!state || typeof state.path !== 'string' || state.path.length === 0
    || (requirements.client && typeof state.client?.test !== 'function')
    || (requirements.deployment && !state.deployment)) {
    throw new ContractError('web_search_state_invalid', 'WebSearch management state is unavailable');
  }
}

function operationFailure(error, code, message) {
  if (error instanceof ContractError) return error;
  const failure = new ContractError(code, `${message}: ${error?.message ?? 'unknown failure'}`);
  failure.cause = error;
  return failure;
}
