// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ContractError } from './ids.js';

const SEARXNG_PROVIDER = 'searxng';
const MAX_CONFIG_BYTES = 65_536;

export const DEFAULT_WEB_SEARCH_CONFIG = Object.freeze({
  version: 1, enabled: false, provider: SEARXNG_PROVIDER, endpoint: null, managed: false,
});

export async function loadWebSearchConfig(path) {
  try {
    const bytes = await readFile(path);
    if (bytes.length > MAX_CONFIG_BYTES) {
      throw new ContractError('web_search_config_too_large', 'WebSearch configuration exceeds its size bound');
    }
    return normalizeWebSearchConfig(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch (error) {
    if (error.code === 'ENOENT') return DEFAULT_WEB_SEARCH_CONFIG;
    if (error instanceof ContractError) throw error;
    throw new ContractError('web_search_config_invalid', 'WebSearch configuration is not valid JSON encoded as UTF-8');
  }
}

export async function saveWebSearchConfig(path, value) {
  const config = normalizeWebSearchConfig(value);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return config;
}

export async function resetWebSearchConfig(path) {
  await rm(path, { force: true });
  return DEFAULT_WEB_SEARCH_CONFIG;
}

export function normalizeWebSearchConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContractError('web_search_config_invalid', 'WebSearch configuration must be an object');
  }
  if (value.provider !== undefined && value.provider !== SEARXNG_PROVIDER) {
    throw new ContractError('web_search_provider_invalid', 'Only the SearXNG search provider is currently supported');
  }
  const enabled = value.enabled === true;
  const endpoint = value.endpoint === null || value.endpoint === undefined
    ? null : normalizeSearxngEndpoint(value.endpoint);
  if (enabled && !endpoint) throw new ContractError('web_search_endpoint_required', 'Enabled WebSearch requires a SearXNG endpoint');
  return Object.freeze({
    version: 1, enabled, provider: SEARXNG_PROVIDER, endpoint,
    managed: value.managed === true,
    updated_at: typeof value.updated_at === 'string' ? value.updated_at : undefined,
  });
}

export function normalizeSearxngEndpoint(value) {
  let url;
  try { url = new URL(value); } catch {
    throw new ContractError('web_search_endpoint_invalid', 'SearXNG endpoint must be an HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ContractError('web_search_endpoint_invalid', 'SearXNG endpoint must be a credential-free HTTP(S) base URL');
  }
  url.pathname = url.pathname.replace(/\/(?:search)?\/?$/u, '') || '/';
  return url.href.replace(/\/$/u, '');
}

export function configuredWebSearch(endpoint, managed = false) {
  return {
    version: 1, enabled: true, provider: SEARXNG_PROVIDER, endpoint: normalizeSearxngEndpoint(endpoint),
    managed, updated_at: new Date().toISOString(),
  };
}
