// SPDX-License-Identifier: Apache-2.0
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ContractError } from './ids.js';

export const DEFAULT_WEB_FETCH_CONFIG = Object.freeze({ version: 1, trusted_origins: Object.freeze([]) });

export async function loadWebFetchConfig(path) {
  try {
    const bytes = await readFile(path);
    if (bytes.length > 65_536) throw new ContractError('web_fetch_config_too_large', 'WebFetch configuration exceeds its size bound');
    return normalizeWebFetchConfig(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch (error) {
    if (error.code === 'ENOENT') return DEFAULT_WEB_FETCH_CONFIG;
    if (error instanceof ContractError) throw error;
    throw new ContractError('web_fetch_config_invalid', 'WebFetch configuration is not valid UTF-8 JSON');
  }
}

export async function saveWebFetchConfig(path, value) {
  const config = normalizeWebFetchConfig(value);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  return config;
}

export function normalizeWebFetchConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const origins = value.trusted_origins ?? [];
  if (!Array.isArray(origins) || origins.length > 64) throw invalid();
  return Object.freeze({
    version: 1,
    trusted_origins: Object.freeze([...new Set(origins.map(normalizeTrustedOrigin))].sort()),
    updated_at: typeof value.updated_at === 'string' ? value.updated_at : undefined,
  });
}

export function normalizeTrustedOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw invalid(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || !['', '/'].includes(url.pathname) || url.search || url.hash) throw invalid();
  return url.origin;
}

function invalid() {
  return new ContractError('web_fetch_config_invalid', 'trusted WebFetch destinations must be exact credential-free HTTP(S) origins');
}
