// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ContractError } from './ids.js';

const SEARXNG_PROVIDER = 'searxng';
const MAX_CONFIG_BYTES = 65_536;
export const MAX_WEB_SEARCH_PROFILES = 8;

export const DEFAULT_WEB_SEARCH_CONFIG = Object.freeze({
  version: 2, enabled: false, profiles: Object.freeze([]),
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
  // Compatibility: version 1 stored one unnamed SearXNG endpoint at the configuration root.
  const sourceProfiles = Array.isArray(value.profiles) ? value.profiles : legacyProfiles(value);
  if (sourceProfiles.length > MAX_WEB_SEARCH_PROFILES) {
    throw new ContractError('web_search_profiles_too_many', `WebSearch supports at most ${MAX_WEB_SEARCH_PROFILES} profiles`);
  }
  const profiles = sourceProfiles.map((item, index) => normalizeProfile(item, index));
  if (new Set(profiles.map((item) => item.id)).size !== profiles.length) {
    throw new ContractError('web_search_profile_duplicate', 'WebSearch profile identifiers must be unique');
  }
  if (new Set(profiles.map((item) => item.endpoint)).size !== profiles.length) {
    throw new ContractError('web_search_endpoint_duplicate', 'WebSearch profile endpoints must be unique');
  }
  const enabled = value.enabled === true;
  if (enabled && profiles.length === 0) {
    throw new ContractError('web_search_endpoint_required', 'Enabled WebSearch requires at least one profile');
  }
  return Object.freeze({ version: 2, enabled, profiles: Object.freeze(profiles) });
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

export function replacePrimaryWebSearch(config, endpoint, managed = false, displayName) {
  const current = normalizeWebSearchConfig(config);
  const existing = current.profiles[0];
  const primary = profile(existing?.id ?? 'primary', displayName ?? existing?.display_name
    ?? (managed ? 'Local SearXNG' : 'Primary SearXNG'), endpoint, managed);
  return buildConfig([primary, ...current.profiles.slice(1).filter((item) => item.endpoint !== primary.endpoint)]);
}

export function appendWebSearchProfile(config, displayName, endpoint) {
  const current = normalizeWebSearchConfig(config);
  if (current.profiles.length >= MAX_WEB_SEARCH_PROFILES) {
    throw new ContractError('web_search_profiles_too_many', `WebSearch supports at most ${MAX_WEB_SEARCH_PROFILES} profiles`);
  }
  const normalizedEndpoint = normalizeSearxngEndpoint(endpoint);
  if (current.profiles.some((item) => item.endpoint === normalizedEndpoint)) {
    throw new ContractError('web_search_endpoint_duplicate', 'That SearXNG endpoint already has a WebSearch profile');
  }
  const id = availableProfileId(displayName, current.profiles.map((item) => item.id));
  return buildConfig([...current.profiles, profile(id, displayName, normalizedEndpoint, false)]);
}

export function promoteWebSearchProfile(config, profileId) {
  const current = normalizeWebSearchConfig(config);
  const index = current.profiles.findIndex((item) => item.id === profileId);
  if (index < 0) throw new ContractError('web_search_profile_missing', `WebSearch profile does not exist: ${profileId}`);
  if (index === 0) return current;
  const profiles = [...current.profiles];
  const [selected] = profiles.splice(index, 1); profiles.unshift(selected);
  return buildConfig(profiles);
}

export function removeWebSearchProfile(config, profileId) {
  const current = normalizeWebSearchConfig(config);
  if (!current.profiles.some((item) => item.id === profileId)) {
    throw new ContractError('web_search_profile_missing', `WebSearch profile does not exist: ${profileId}`);
  }
  const profiles = current.profiles.filter((item) => item.id !== profileId);
  return Object.freeze({ version: 2, enabled: profiles.length > 0 && current.enabled, profiles: Object.freeze(profiles) });
}

function legacyProfiles(value) {
  if (value.provider !== undefined && value.provider !== SEARXNG_PROVIDER) {
    throw new ContractError('web_search_provider_invalid', 'Only the SearXNG search provider is currently supported');
  }
  if (value.endpoint === null || value.endpoint === undefined) return [];
  return [{
    id: 'primary', display_name: value.managed === true ? 'Local SearXNG' : 'Primary SearXNG',
    provider: SEARXNG_PROVIDER, endpoint: value.endpoint, managed: value.managed === true,
  }];
}

function normalizeProfile(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContractError('web_search_profile_invalid', 'Each WebSearch profile must be an object');
  }
  if (value.provider !== undefined && value.provider !== SEARXNG_PROVIDER) {
    throw new ContractError('web_search_provider_invalid', 'Only the SearXNG search provider is currently supported');
  }
  const id = normalizeProfileId(value.id ?? `search-${index + 1}`);
  const displayName = normalizeDisplayName(value.display_name ?? value.displayName ?? id);
  return Object.freeze({
    id, display_name: displayName, provider: SEARXNG_PROVIDER,
    endpoint: normalizeSearxngEndpoint(value.endpoint), managed: value.managed === true,
  });
}

function profile(id, displayName, endpoint, managed) {
  return normalizeProfile({ id, display_name: displayName, provider: SEARXNG_PROVIDER, endpoint, managed }, 0);
}

function buildConfig(profiles) {
  return normalizeWebSearchConfig({ version: 2, enabled: profiles.length > 0, profiles });
}

function normalizeProfileId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(value)) {
    throw new ContractError('web_search_profile_id_invalid', 'WebSearch profile ID must use 1–64 lowercase letters, numbers, or hyphens');
  }
  return value;
}

function normalizeDisplayName(value) {
  if (typeof value !== 'string' || value.trim().length < 1 || Array.from(value.trim()).length > 128) {
    throw new ContractError('web_search_profile_name_invalid', 'WebSearch profile name must contain 1–128 characters');
  }
  return value.trim();
}

function availableProfileId(label, existingIds) {
  const stem = String(label).normalize('NFKD').replaceAll(/\p{Mark}/gu, '').toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-').replaceAll(/^-+|-+$/gu, '').slice(0, 56) || 'search';
  const existing = new Set(existingIds);
  if (!existing.has(stem)) return stem;
  for (let index = 2; index <= 9999; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${stem.slice(0, 64 - suffix.length)}${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new ContractError('web_search_profile_id_exhausted', 'Unable to create a unique WebSearch profile identifier');
}
