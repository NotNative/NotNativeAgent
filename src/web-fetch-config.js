// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ContractError } from './ids.js';

export const DEFAULT_WEB_FETCH_CONFIG = Object.freeze({ version: 1, trusted_origins: Object.freeze([]) });
const WEB_FETCH_CONFIG_VERSION = 1;
const MAX_CONFIG_BYTES = 65_536;

export async function loadWebFetchConfig(path) {
  try {
    const bytes = await readFile(path);
    if (bytes.length > MAX_CONFIG_BYTES) throw new ContractError('web_fetch_config_too_large', 'WebFetch configuration exceeds its size bound');
    return normalizeWebFetchConfig(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch (error) {
    if (error.code === 'ENOENT') return DEFAULT_WEB_FETCH_CONFIG;
    if (error instanceof ContractError) throw error;
    throw new ContractError('web_fetch_config_invalid', 'WebFetch configuration is not valid JSON encoded as UTF-8');
  }
}

export async function saveWebFetchConfig(path, value) {
  const config = normalizeWebFetchConfig(value);
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

export function normalizeWebFetchConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  if (value.version !== undefined && value.version !== WEB_FETCH_CONFIG_VERSION) {
    throw new ContractError('web_fetch_config_version_unsupported', 'WebFetch configuration version is not supported');
  }
  const origins = value.trusted_origins ?? [];
  if (!Array.isArray(origins) || origins.length > 64) throw invalid();
  return Object.freeze({
    version: WEB_FETCH_CONFIG_VERSION,
    trusted_origins: Object.freeze([...new Set(origins.map(normalizeTrustedOrigin))].sort()),
    updated_at: normalizeTimestamp(value.updated_at),
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
  return new ContractError('web_fetch_config_invalid', 'trusted WebFetch origins must be exact credential-free HTTP(S) origins');
}

function normalizeTimestamp(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new ContractError('web_fetch_config_invalid', 'WebFetch updated_at must be a canonical ISO 8601 timestamp');
  }
  return value;
}
