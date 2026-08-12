// SPDX-License-Identifier: Apache-2.0
import {
  configuredWebSearch, loadWebSearchConfig, resetWebSearchConfig, saveWebSearchConfig,
} from './web-search-config.js';
import { ContractError } from './ids.js';

export async function webSearchStatus(state, test = false) {
  const config = await loadWebSearchConfig(state.path);
  let checked = null;
  if (test && config.enabled) {
    checked = await state.client.test(config.endpoint).catch((error) => ({ ok: false, error: error.code ?? error.message }));
  }
  return { config, test: checked };
}

export async function configureWebSearch(state, endpoint, managed = false) {
  const candidate = configuredWebSearch(endpoint, managed);
  const checked = await state.client.test(candidate.endpoint);
  return { config: await saveWebSearchConfig(state.path, candidate), test: checked };
}

export async function disableWebSearch(state) {
  return { config: await resetWebSearchConfig(state.path), test: null, disabled: true };
}

export async function resetWebSearch(state) {
  return { config: await resetWebSearchConfig(state.path), test: null, reset: true };
}

export async function deployWebSearch(state) {
  const deployment = await state.deployment.deploy();
  return { ...await configureWebSearch(state, deployment.endpoint, true), deployment };
}

export async function removeWebSearchDeployment(state) {
  const current = await loadWebSearchConfig(state.path);
  const deployment = await state.deployment.remove();
  const config = current.managed ? await resetWebSearchConfig(state.path) : current;
  return { config, test: null, deployment, removed: true };
}

export async function manageWebSearch(state, action) {
  if (action === 'start') await state.deployment.start();
  else if (action === 'stop') await state.deployment.stop();
  else throw new ContractError('web_search_action_invalid', 'unknown managed WebSearch action');
  return webSearchStatus(state, action === 'start');
}
