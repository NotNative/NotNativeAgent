// SPDX-License-Identifier: Apache-2.0
import { createPublicKey } from 'node:crypto';

const MAX_HOSTS = 100;
const MAX_HEADER_COUNT = 32;
const MAX_HEADER_VALUE_LENGTH = 2_048;
const MAX_CLIENT_TOKEN_LENGTH = 8_192;
const FORBIDDEN_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'proxy-authorization', 'host', 'origin']);

function cleanString(value, maxLength) {
  if (typeof value !== 'string') return '';
  const result = value.trim();
  return result.length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(result) ? result : '';
}

function safeHttpUrl(value) {
  const raw = cleanString(value, 4_096);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    url.hash = '';
    return url.href.replace(/\/$/u, '');
  } catch { return ''; }
}

function safeRelayUrl(value) {
  const raw = cleanString(value, 4_096);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname || url.username || url.password) return '';
    url.hash = '';
    return url.href;
  } catch { return ''; }
}

function sanitizeHeaders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = {};
  for (const [rawName, rawValue] of Object.entries(value).slice(0, MAX_HEADER_COUNT)) {
    const name = rawName.trim().toLowerCase();
    if (!/^[a-z0-9-]{1,80}$/u.test(name) || FORBIDDEN_HEADERS.has(name) || typeof rawValue !== 'string') continue;
    const headerValue = cleanString(rawValue, MAX_HEADER_VALUE_LENGTH);
    if (headerValue) result[name] = headerValue;
  }
  return Object.keys(result).length ? result : undefined;
}

function sanitizeRelay(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const relayUrl = safeRelayUrl(value.relayUrl);
  const serverId = cleanString(value.serverId, 256);
  const jwk = value.hostEncPubJwk;
  if (!relayUrl || !serverId || !jwk || typeof jwk !== 'object' || Array.isArray(jwk)
    || jwk.kty !== 'EC' || jwk.crv !== 'P-256'
    || typeof jwk.x !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(jwk.x)
    || typeof jwk.y !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(jwk.y)) return undefined;
  // Shape checks alone accept syntactically sized but non-canonical or
  // off-curve coordinates. Such descriptors persist successfully, then fail
  // only when the relay tunnel imports the key. Validate at the storage edge.
  try {
    createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
  } catch { return undefined; }
  return { relayUrl, serverId, hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } };
}

export function sanitizeDesktopHost(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const id = cleanString(input.id, 128);
  if (!id || id === 'local') return null;
  const directUrl = safeHttpUrl(input.url);
  const apiUrl = safeHttpUrl(input.apiUrl) || directUrl;
  const relay = sanitizeRelay(input.relay);
  if (!directUrl && !relay) return null;
  const url = directUrl || `relay://${relay.serverId}`;
  const clientToken = cleanString(input.clientToken, MAX_CLIENT_TOKEN_LENGTH);
  const requestHeaders = sanitizeHeaders(input.requestHeaders);
  return {
    id,
    label: cleanString(input.label, 256) || url,
    url,
    ...(apiUrl ? { apiUrl } : {}),
    ...(clientToken ? { clientToken } : {}),
    ...(requestHeaders ? { requestHeaders } : {}),
    ...(relay ? { relay } : {}),
  };
}

export function sanitizeDesktopHostsConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Hosts configuration is invalid');
  if (!Array.isArray(input.hosts) || input.hosts.length > MAX_HOSTS) throw new Error('Hosts list is invalid');
  const hosts = [];
  const ids = new Set();
  for (const entry of input.hosts) {
    const host = sanitizeDesktopHost(entry);
    if (!host) throw new Error('A host entry is invalid');
    if (ids.has(host.id)) throw new Error('Host IDs must be unique');
    ids.add(host.id);
    hosts.push(host);
  }
  const defaultHostId = input.defaultHostId === 'local' ? 'local'
    : typeof input.defaultHostId === 'string' && ids.has(input.defaultHostId) ? input.defaultHostId : null;
  if (input.defaultHostId !== null && input.defaultHostId !== undefined && defaultHostId === null) {
    throw new Error('Default host does not exist');
  }
  const initialHostChoiceCompleted = input.initialHostChoiceCompleted === true;
  const config = { hosts, defaultHostId, initialHostChoiceCompleted };
  if (Object.hasOwn(input, 'localClientToken')) {
    const token = cleanString(input.localClientToken, MAX_CLIENT_TOKEN_LENGTH);
    config.localClientToken = token || null;
  }
  return config;
}

export function readDesktopHostsConfig(prefs = {}) {
  const raw = {
    hosts: Array.isArray(prefs.desktopHosts) ? prefs.desktopHosts : [],
    defaultHostId: typeof prefs.desktopDefaultHostId === 'string' ? prefs.desktopDefaultHostId : null,
    initialHostChoiceCompleted: prefs.desktopInitialHostChoiceCompleted === true,
  };
  try { return sanitizeDesktopHostsConfig(raw); }
  catch { return { hosts: [], defaultHostId: null, initialHostChoiceCompleted: false }; }
}
