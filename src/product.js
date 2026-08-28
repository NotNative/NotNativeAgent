// SPDX-License-Identifier: Apache-2.0
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { ContractError } from './ids.js';

export const PRODUCT_NAME = 'NotNativeAgent';
export const VERSION = '20260828-2';
// scripts/bump-version.js updates this canonical date-iteration version and all distribution mirrors atomically.

const USER_DATA_FILE_KEYS = new Set([
  'modelDialects', 'dreamState', 'nnmGovernanceReceipts', 'webSearchConfig', 'webFetchConfig',
  'gatewayConfig', 'providerCredentials', 'mcpCredentials', 'secretVault', 'secretKey', 'secretAudit',
  'trustedWorkspaces', 'updateState',
]);

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
    modelDialects: join(root, 'provider/model-dialects.json'),
    dreamState: join(root, 'runtime', 'dream-state.db'),
    nnmGovernanceReceipts: join(root, 'runtime', 'nnm-turn-receipts.jsonl'),
    sessions: join(root, 'sessions'),
    governanceLedger: join(root, 'governance-ledger'),
    reviewerLedger: join(root, 'reviewer-ledger'),
    config: join(root, 'config'),
    webSearchConfig: join(root, 'config', 'web-search.json'),
    webFetchConfig: join(root, 'config', 'web-fetch.json'),
    gatewayConfig: join(root, 'config', 'gateway.json'),
    providerCredentials: join(root, 'config', 'provider-credentials.json'),
    mcpCredentials: join(root, 'config', 'mcp-credentials.json'),
    secrets: join(root, 'secrets'),
    secretVault: join(root, 'secrets', 'vault.json'),
    secretKey: join(root, 'secrets', 'master-key.json'),
    secretAudit: join(root, 'secrets', 'audit.ndjson'),
    trustedWorkspaces: join(root, 'config', 'trusted-workspaces.json'),
    logs: join(root, 'logs'),
    support: join(root, 'support'),
    hooks: join(root, 'hooks'),
    skills: join(root, 'skills'),
    managedSearxng: join(root, 'managed', 'searxng'),
    managedPlaywright: join(root, 'managed', 'playwright'),
    rootTui: join(root, 'runtime', 'root-tui'),
    gateway: join(root, 'runtime', 'gateway'),
    sessionBrokers: join(root, 'runtime', 'session-brokers'),
    telegramOutbox: join(root, 'runtime', 'telegram-outbox'),
    elevation: join(root, 'runtime', 'elevation'),
    gatewayWorkspace: join(root, 'gateway', 'workspace'),
    updateState: join(root, 'runtime', 'update-state.json'),
    updateRoot: join(root, 'runtime', 'updates'),
  });
}

export async function ensureUserDataPaths(paths = userDataPaths()) {
  const directories = [...new Set(Object.entries(paths)
    .filter(([key, value]) => key !== 'root' && typeof value === 'string' && !USER_DATA_FILE_KEYS.has(key))
    .map(([, value]) => value))];
  if (typeof paths.root === 'string') directories.unshift(paths.root);
  const results = await Promise.allSettled(directories.map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
  const failures = results.flatMap((result, index) => result.status === 'rejected'
    ? [Object.assign(result.reason, { dataPath: directories[index] })] : []);
  if (failures.length > 0) {
    throw new AggregateError(failures, `failed to create ${failures.length} user data director${failures.length === 1 ? 'y' : 'ies'}`);
  }
  return paths;
}
