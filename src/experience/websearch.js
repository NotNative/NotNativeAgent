// SPDX-License-Identifier: Apache-2.0
import {
  configuredWebSearch, loadWebSearchConfig, resetWebSearchConfig, saveWebSearchConfig,
} from '../web-search-config.js';
import { ContractError } from '../ids.js';

export async function webSearchStatus(state, test = false) {
  requireWebSearchState(state, { client: test });
  const config = await loadWebSearchConfig(state.path);
  let checked = null;
  if (test && config.enabled) {
    checked = await state.client.test(config.endpoint).catch((error) => ({ ok: false, error: error.code ?? error.message }));
  }
  return { config, test: checked };
}

export async function configureWebSearch(state, endpoint, managed = false) {
  requireWebSearchState(state, { client: true });
  const candidate = configuredWebSearch(endpoint, managed);
  try {
    const checked = await state.client.test(candidate.endpoint);
    return { config: await saveWebSearchConfig(state.path, candidate), test: checked };
  } catch (error) {
    throw operationFailure(error, 'web_search_configuration_failed', 'WebSearch configuration could not be verified and saved');
  }
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
    error.partialDeployment = deployment;
    throw error;
  }
}

export async function removeWebSearchDeployment(state) {
  requireWebSearchState(state, { deployment: true });
  const current = await loadWebSearchConfig(state.path);
  const deployment = await state.deployment.remove();
  const config = current.managed ? await resetWebSearchConfig(state.path) : current;
  return { config, test: null, deployment, removed: true };
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
  return webSearchStatus(state, action === 'start');
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
