// SPDX-License-Identifier: Apache-2.0
// Persisted configuration for the OpenCode wiring service surface. Records the
// fixed wire identity (hostname, port, Basic auth credentials) that the login
// startup script and the OpenChamber user environment mirror. Cf. gateway config:
// absent-safe, size-bounded, atomic 0600 writes, redacted public status.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
// Why: net.isIPv6 is the authoritative IPv6-literal parser; a loose regex
// would accept strings like `aaa:bbb` that pass normalization but can never
// become a listenable address or a valid OPENCODE_HOST origin.
import { isIPv6 as isIPv6Address } from 'node:net';
import { dirname, resolve } from 'node:path';
import { ContractError } from '../ids.js';

const MAX_CONFIG_BYTES = 65_536;
const DEFAULT_BIND_PORT = 4095;
const CONFIG_VERSION = 1;

export const DEFAULT_OPENCODE_CONFIG = Object.freeze({
  version: CONFIG_VERSION, enabled: false,
  hostname: '127.0.0.1', port: DEFAULT_BIND_PORT,
  username: 'opencode', password: null,
});

export async function loadOpenCodeConfig(path) {
  try {
    const bytes = await readFile(path);
    if (bytes.length > MAX_CONFIG_BYTES) throw new ContractError('opencode_config_too_large', 'opencode configuration exceeds its size bound');
    return normalizeOpenCodeConfig(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch (error) {
    if (error.code === 'ENOENT') return DEFAULT_OPENCODE_CONFIG;
    if (error instanceof ContractError) throw error;
    const failure = new ContractError('opencode_config_invalid', 'opencode configuration is not valid UTF-8 JSON');
    failure.cause = error;
    throw failure;
  }
}

export async function openCodeConfigExists(path) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function saveOpenCodeConfig(path, value) {
  const config = normalizeOpenCodeConfig(value);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return config;
}

export function normalizeOpenCodeConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContractError('opencode_config_invalid', 'opencode configuration must be an object');
  }
  // Why: files written by a newer NNA may carry wire-identity or credential
  // semantics this build cannot interpret; refusing loudly here beats
  // silently reshaping rewired enablement and credentials on the next save.
  if (value.version !== undefined && value.version !== CONFIG_VERSION) {
    throw new ContractError('opencode_config_version_unsupported', `opencode configuration version ${String(value.version)} is not supported by this NNA build`);
  }
  const hostname = normalizeHostname(value.hostname ?? DEFAULT_OPENCODE_CONFIG.hostname);
  const port = value.port ?? DEFAULT_BIND_PORT;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new ContractError('opencode_bind_port_invalid', 'opencode bind port must be an integer from 1 through 65535');
  }
  const username = normalizeUsername(value.username ?? DEFAULT_OPENCODE_CONFIG.username);
  const password = normalizeOptionalSecret(value.password);
  // Why: binding beyond loopback is an explicit operator decision that keeps
  // its auth surface active (ADR 0020); an unauthenticated exposed bind fails
  // closed at configuration time instead of opening a network-listening agent.
  if (!isLoopbackHostname(hostname) && !password) {
    throw new ContractError('opencode_bind_exposed_requires_password', 'an opencode bind beyond loopback requires Basic auth credentials');
  }
  const updatedAt = normalizeUpdatedAt(value.updated_at);
  return Object.freeze({
    version: CONFIG_VERSION,
    enabled: value.enabled === true,
    hostname,
    port,
    username,
    password,
    ...(updatedAt === null ? {} : { updated_at: updatedAt }),
  });
}

export function generateOpencodePassword() {
  const value = randomBytes(32).toString('base64url');
  if (value.length < 20 || value.length > 512 || /[\r\n]/u.test(value)) {
    throw new ContractError('opencode_password_invalid', 'generated opencode password is invalid');
  }
  return value;
}

export function opencodePublicStatus(config, environment = process.env) {
  const password = environment.OPENCODE_SERVER_PASSWORD?.trim();
  return Object.freeze({
    enabled: config.enabled,
    configured: Boolean(config.password ?? password),
    password_source: config.password ? 'restricted local config' : password ? 'environment' : null,
    username: config.username,
    hostname: config.hostname,
    port: config.port,
    bind_url: bindUrl(config),
  });
}

export function bindUrl(config) {
  // Why: IPv6 bind hostnames are only addressable inside an origin when
  // bracketed, and OpenChamber validates OPENCODE_HOST as a URL with an
  // explicit port and no path.
  const host = String(config.hostname).includes(':')
    ? `[${config.hostname.replace(/^\[/u, '').replace(/\]$/u, '')}]`
    : config.hostname;
  return `http://${host}:${config.port}`;
}

export function isLoopbackHostname(hostname) {
  const value = String(hostname ?? '').replace(/^\[|\]$/gu, '').toLowerCase();
  if (value === 'localhost' || value === '::1') return true;
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
    && Number(parts[0]) === 127;
}

function normalizeHostname(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) {
    throw new ContractError('opencode_hostname_invalid', 'opencode hostname must be a non-empty bind hostname');
  }
  const trimmed = value.trim();
  // Why: IPv6 literals are stored bare and bracketed only where a published
  // origin needs it (bindUrl), so server.listen in the managed runtime receives
  // an address without literal brackets.
  const candidate = trimmed.startsWith('[') && trimmed.endsWith(']')
    ? trimmed.slice(1, -1)
    : trimmed;
  if (candidate.includes('[') || candidate.includes(']')) {
    throw new ContractError('opencode_hostname_invalid', 'opencode hostname must be an IP address or hostname without scheme or port');
  }
  if (isIPv4(candidate) || isIPv6Address(candidate) || isDnsHostname(candidate)) return candidate;
  throw new ContractError('opencode_hostname_invalid', 'opencode hostname must be an IP address or hostname without scheme or port');
}

function isIPv4(value) {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255);
}

function isDnsHostname(value) {
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/u.test(value)
    && !/^\d+(?:\.\d+)+$/u.test(value);
}

function normalizeUsername(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64
    || /[:\r\n\u0000-\u001f]/u.test(value)) {
    throw new ContractError('opencode_username_invalid', 'opencode Basic auth username is invalid');
  }
  return value.trim();
}

function normalizeOptionalSecret(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length < 20 || value.length > 512 || /[\r\n]/u.test(value)) {
    throw new ContractError('opencode_password_invalid', 'opencode Basic auth password is invalid');
  }
  return value;
}

function normalizeUpdatedAt(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !value.trim()) {
    throw new ContractError('opencode_config_invalid', 'opencode configuration updated_at must be an ISO timestamp');
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.valueOf()) || timestamp.toISOString() !== value) {
    throw new ContractError('opencode_config_invalid', 'opencode configuration updated_at must be an ISO timestamp');
  }
  return value;
}
