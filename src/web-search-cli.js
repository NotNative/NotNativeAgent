// SPDX-License-Identifier: Apache-2.0
import {
  configuredWebSearch, loadWebSearchConfig, resetWebSearchConfig, saveWebSearchConfig,
} from './web-search-config.js';
import { SearxngClient } from './searxng-client.js';
import { SearxngDeployment } from './searxng-deployment.js';
import { ContractError } from './ids.js';

const ACTION = Object.freeze({
  status: 'status', refreshManaged: 'refresh-managed', reset: 'reset', disable: 'disable',
  installIfUnconfigured: 'install-if-unconfigured', configure: 'configure', deploy: 'deploy',
  installLocal: 'install-local', remove: 'remove', removeDeployment: 'remove-deployment',
});

export async function runWebSearchCommand(args, paths, options = {}) {
  validateRuntime(args, paths, options);
  const action = args[0] ?? ACTION.status;
  let client;
  const searchClient = () => (client ??= options.client ?? new SearxngClient());
  const managedDeployment = () => options.deployment
    ?? new SearxngDeployment({ root: paths.managedSearxng, client: searchClient() });
  const current = await loadWebSearchConfig(paths.webSearchConfig);
  if (action === ACTION.status) return { configured: current.enabled, config: current };
  if (action === ACTION.refreshManaged) {
    if (!current.enabled || !current.managed) return { skipped: true, reason: 'not_managed', config: current };
    const refreshed = await managedDeployment().refreshIfNeeded();
    return { configured: true, config: current, deployment: refreshed, refreshed: refreshed.refreshed === true };
  }
  if (action === ACTION.reset || action === ACTION.disable) {
    return { configured: false, reset: true, config: await resetWebSearchConfig(paths.webSearchConfig) };
  }
  if (action === ACTION.installIfUnconfigured && current.enabled) return { skipped: true, reason: 'already_configured', config: current };
  if (action === ACTION.installIfUnconfigured && !args[1]) {
    throw new ContractError('web_search_endpoint_required', 'install-if-unconfigured requires an endpoint; use deploy for managed local SearXNG');
  }
  if (action === ACTION.configure || action === ACTION.installIfUnconfigured) {
    const endpoint = args[1];
    if (typeof endpoint !== 'string' || !endpoint.trim()) {
      throw new ContractError('web_search_endpoint_required', 'configure requires a SearXNG endpoint');
    }
    const candidate = configuredWebSearch(endpoint, false);
    const test = await searchClient().test(candidate.endpoint);
    return { config: await saveWebSearchConfig(paths.webSearchConfig, candidate), test };
  }
  if (action === ACTION.deploy || action === ACTION.installLocal) {
    const deployed = await managedDeployment().deploy();
    const config = await saveWebSearchConfig(paths.webSearchConfig, configuredWebSearch(deployed.endpoint, true));
    return { config, deployment: deployed };
  }
  if (action === ACTION.remove || action === ACTION.removeDeployment) {
    const removed = await managedDeployment().remove();
    const config = current.managed ? await resetWebSearchConfig(paths.webSearchConfig) : current;
    return { config, deployment: removed, removed: true };
  }
  throw new ContractError('invalid_web_search_command', 'invalid WebSearch command');
}

function validateRuntime(args, paths, options) {
  if (!Array.isArray(args) || args.some((item) => typeof item !== 'string')) {
    throw new ContractError('invalid_web_search_command', 'WebSearch arguments must be strings');
  }
  if (typeof paths?.webSearchConfig !== 'string' || typeof paths?.managedSearxng !== 'string'
    || !options || typeof options !== 'object' || Array.isArray(options)) {
    throw new ContractError('web_search_runtime_invalid', 'WebSearch requires valid runtime paths and options');
  }
}
