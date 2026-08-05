// SPDX-License-Identifier: Apache-2.0
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { ContractError } from './ids.js';

export const PRODUCT_NAME = 'NotNativeAgent';
export const VERSION = '20260805-5';

export function userDataPaths(options = {}) {
  const environment = options.environment ?? process.env;
  const home = options.home ?? homedir();
  if (!home || !isAbsolute(home)) throw new ContractError('home_directory_unavailable', 'an absolute home directory is required');
  const override = environment.NNA_HOME?.trim();
  if (override && !isAbsolute(override)) {
    throw new ContractError('invalid_nna_home', 'NNA_HOME must be an absolute path');
  }
  const root = override ? resolve(override) : resolve(home, '.nna');
  return Object.freeze({
    root,
    projects: join(root, 'projects'),
    modelDialects: join(root, 'model-dialects.json'),
    dreamState: join(root, 'runtime', 'dream-state.db'),
    sessions: join(root, 'sessions'),
    reviewerLedger: join(root, 'reviewer-ledger'),
    config: join(root, 'config'),
    webSearchConfig: join(root, 'config', 'web-search.json'),
    webFetchConfig: join(root, 'config', 'web-fetch.json'),
    gatewayConfig: join(root, 'config', 'gateway.json'),
    providerCredentials: join(root, 'config', 'provider-credentials.json'),
    mcpCredentials: join(root, 'config', 'mcp-credentials.json'),
    trustedWorkspaces: join(root, 'config', 'trusted-workspaces.json'),
    logs: join(root, 'logs'),
    support: join(root, 'support'),
    hooks: join(root, 'hooks'),
    skills: join(root, 'skills'),
    managedSearxng: join(root, 'managed', 'searxng'),
    rootTui: join(root, 'runtime', 'root-tui'),
    gateway: join(root, 'runtime', 'gateway'),
    gatewayWorkspace: join(root, 'gateway', 'workspace'),
  });
}

export async function ensureUserDataPaths(paths = userDataPaths()) {
  for (const path of [paths.root, paths.projects, paths.sessions, paths.reviewerLedger, paths.config, paths.logs, paths.support, paths.hooks, paths.skills, paths.managedSearxng, paths.rootTui, paths.gateway, paths.gatewayWorkspace]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  return paths;
}
