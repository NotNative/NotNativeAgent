// SPDX-License-Identifier: Apache-2.0
import { configuredWebSearch, loadWebSearchConfig, saveWebSearchConfig } from './web-search-config.js';
import { SearxngClient } from './searxng-client.js';
import { SearxngDeployment } from './searxng-deployment.js';

export async function runWebSearchCommand(args, paths, options = {}) {
  const action = args[0] ?? 'status';
  const client = options.client ?? new SearxngClient();
  const deployment = options.deployment ?? new SearxngDeployment({ root: paths.managedSearxng, client });
  const current = await loadWebSearchConfig(paths.webSearchConfig);
  if (action === 'status') return { configured: current.enabled, config: current };
  if (action === 'install-if-unconfigured' && current.enabled) return { skipped: true, reason: 'already_configured', config: current };
  if (action === 'configure' || (action === 'install-if-unconfigured' && args[1])) {
    const endpoint = args[1];
    const candidate = configuredWebSearch(endpoint, false);
    const test = await client.test(candidate.endpoint);
    return { config: await saveWebSearchConfig(paths.webSearchConfig, candidate), test };
  }
  if (action === 'deploy' || action === 'install-local') {
    const deployed = await deployment.deploy();
    const config = await saveWebSearchConfig(paths.webSearchConfig, configuredWebSearch(deployed.endpoint, true));
    return { config, deployment: deployed };
  }
  throw Object.assign(new Error('invalid WebSearch command'), { code: 'invalid_web_search_command' });
}
