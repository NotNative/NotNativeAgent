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
  const current = await loadWebSearchConfig(state.path);
  const config = await saveWebSearchConfig(state.path, {
    ...current, enabled: false, updated_at: new Date().toISOString(),
  });
  return { config, test: null };
}

export async function resetWebSearch(state) {
  return { config: await resetWebSearchConfig(state.path), test: null, reset: true };
}

export async function deployWebSearch(state) {
  await state.deployment.deploy();
  return configureWebSearch(state, 'http://127.0.0.1:8888', true);
}

export async function manageWebSearch(state, action) {
  if (action === 'start') await state.deployment.start();
  else if (action === 'stop') await state.deployment.stop();
  else throw new ContractError('web_search_action_invalid', 'unknown managed WebSearch action');
  return webSearchStatus(state, action === 'start');
}
