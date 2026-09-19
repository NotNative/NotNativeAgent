// SPDX-License-Identifier: Apache-2.0
/**
 * Tunnel start-request normalization and validation (doc 08 §4.2):
 * `normalizeTunnelStartRequest(input, defaults)` produces the canonical
 * `{provider, mode, intent, configPath, token, hostname}` shape. Fallbacks:
 * blank mode/provider ride the settings defaults, then the registry
 * defaults (quick/cloudflare); an EXTANT-unrecognized value is an
 * *unsupported* error (422 in routes), not a silent fallback. A request
 * carrying an `intent` must equal the mode descriptor's intent —
 * `private-network` passes string recognition but never matches a mode.
 * `configPath` must resolve inside the user's home directory
 * (win32 case-insensitive); `token` rejects any whitespace; `hostname`
 * normalizes to a lower-case host and rejects wildcards/empties.
 */
import { homedir } from 'node:os';
import { join as pathJoin, resolve as pathResolve, sep } from 'node:path';
import {
  DEFAULT_TUNNEL_MODE, DEFAULT_TUNNEL_PROVIDER,
  modeIntentDefault, tunnelModeCapability,
  type TunnelIntent, type TunnelMode, type TunnelProvider,
} from './tunnel-capabilities.ts';

export type TunnelServiceErrorCode =
  | 'validation_error'
  | 'provider_unsupported'
  | 'mode_unsupported'
  | 'missing_dependency'
  | 'startup_failed';

export class TunnelServiceError extends Error {
  readonly code: TunnelServiceErrorCode;
  readonly detail: string | null;

  constructor(code: TunnelServiceErrorCode, message: string, detail: string | null = null) {
    super(message);
    this.name = 'TunnelServiceError';
    this.code = code;
    this.detail = detail;
  }
}

export interface NormalizedTunnelStartRequest {
  provider: TunnelProvider;
  mode: TunnelMode;
  intent: TunnelIntent;
  /** Absolute path inside the user's home directory — managed-local; null
   * means "the default ~/.cloudflared/config.yml". */
  configPath: string | null;
  /** Cloudflared run token — managed-remote; null otherwise. */
  token: string | null;
  /** Lower-case public hostname — managed-*; null for quick. */
  hostname: string | null;
}

export interface TunnelStartDefaults {
  provider?: unknown;
  mode?: unknown;
  configPath?: unknown;
  token?: unknown;
  hostname?: unknown;
}

export const MANAGED_LOCAL_DEFAULT_CONFIG_PATH = homedir() === '' || homedir() === '/'
  ? ''
  : pathJoin(homedir(), '.cloudflared', 'config.yml');

function unsupportedProvider(value: unknown): TunnelServiceError {
  return new TunnelServiceError('provider_unsupported', 'Unsupported tunnel provider', `unsupported provider: ${String(value)}`);
}

function unsupportedMode(provider: TunnelProvider, value: unknown): TunnelServiceError {
  return new TunnelServiceError('mode_unsupported', 'Unsupported tunnel mode', `unsupported mode for ${provider}: ${String(value)}`);
}

/** Blank rides the settings default, then the registry default; a typed or
 * unrecognized value is an unsupported error. */
function recognizedProvider(fromRequest: unknown, fromDefaults: unknown): TunnelProvider {
  for (const value of [fromRequest, fromDefaults]) {
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string') throw unsupportedProvider(value);
    if (value === 'cloudflare' || value === 'ngrok') return value;
    throw unsupportedProvider(value);
  }
  return DEFAULT_TUNNEL_PROVIDER;
}

function recognizedMode(provider: TunnelProvider, fromRequest: unknown, fromDefaults: unknown): TunnelMode {
  for (const value of [fromRequest, fromDefaults]) {
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string') throw unsupportedMode(provider, value);
    if (provider === 'cloudflare' && (value === 'quick' || value === 'managed-local' || value === 'managed-remote')) return value;
    if (provider === 'ngrok' && value === 'quick') return value;
    throw unsupportedMode(provider, value);
  }
  return provider === 'ngrok' ? DEFAULT_TUNNEL_MODE : DEFAULT_TUNNEL_MODE;
}

function isAbsoluteConfigPath(value: string): boolean {
  if (value.startsWith('/') || value.startsWith('\\')) return true;
  return /^[a-zA-Z]:[\\/]/u.test(value);
}

/** `~`, `~/relative`, tilde-free absolute; must resolve inside the user's
 * home directory (win32 case-insensitive) — §4.2. */
export function resolveTunnelConfigPath(input: unknown): string | null {
  if (input === undefined || input === null || input === '') return null;
  if (typeof input !== 'string') {
    throw new TunnelServiceError('validation_error', 'Tunnel config path must be a string', 'configPath must be a string');
  }
  const home = homedir();
  const raw = input.trim();
  if (raw === '') return null;
  let resolved: string;
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
    resolved = pathJoin(home, raw.slice(1).replace(/^[/\\]/, ''));
  } else if (isAbsoluteConfigPath(raw)) {
    resolved = raw;
  } else {
    throw new TunnelServiceError('validation_error', 'Tunnel config path must be absolute or start with ~', 'configPath must be absolute or ~-anchored');
  }
  resolved = pathResolve(resolved);
  if (!isInsideHome(home, resolved)) {
    throw new TunnelServiceError('validation_error', 'Tunnel config path must stay inside the home directory', 'configPath escapes the home directory');
  }
  return resolved;
}

function isInsideHome(home: string, candidate: string): boolean {
  const [h, c] = process.platform === 'win32' ? [home.toLowerCase(), candidate.toLowerCase()] : [home, candidate];
  if (h === c) return true;
  return c.startsWith(h.endsWith(sep) ? h : h + sep);
}

/** Lower-case host; accepts `host` or `https://host[/...]`; wildcards and
 * empties are rejected (§4.2). */
export function resolveTunnelHostname(input: unknown): string | null {
  if (input === undefined || input === null || input === '') return null;
  if (typeof input !== 'string') {
    throw new TunnelServiceError('validation_error', 'Tunnel hostname must be a string', 'hostname must be a string');
  }
  let host = input.trim();
  if (host === '') return null;
  try {
    const parsed = new URL(host);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') host = parsed.hostname;
  } catch {
    // bare-host input (new URL throws on 'tunnel.example.com')
  }
  host = host.trim().toLowerCase();
  if (host === '' || host.includes('*')) {
    throw new TunnelServiceError('validation_error', 'Tunnel hostname must be a concrete host', 'wildcard or empty hostname');
  }
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u.test(host) || host.includes('..')) {
    throw new TunnelServiceError('validation_error', 'Tunnel hostname is not a valid public host', `invalid hostname: ${host}`);
  }
  return host;
}

/** §4.2 token rule: any whitespace character invalidates; the remediation
 * text names the raw-value contract. */
export function resolveTunnelToken(input: unknown): string | null {
  if (input === undefined || input === null || input === '') return null;
  if (typeof input !== 'string') {
    throw new TunnelServiceError('validation_error', 'Tunnel token must be a string', 'token must be a string');
  }
  if (/\s/u.test(input)) {
    throw new TunnelServiceError('validation_error', 'Tunnel token must not contain whitespace; provide the raw token value', 'token whitespace');
  }
  return input === '' ? null : input;
}

/** §4.1 fallback order: request field → settings default → registry
 * default; an explicitly carried `intent` must equal the mode descriptor's
 * declared intent (§4.2). */
export function normalizeTunnelStartRequest(input: unknown, defaults: TunnelStartDefaults = {}): NormalizedTunnelStartRequest {
  const source = input === null || input === undefined ? {} : input;
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new TunnelServiceError('validation_error', 'Tunnel start body must be a JSON object', 'start body shape');
  }
  const body = source as Record<string, unknown>;
  const provider = recognizedProvider(body.provider, defaults.provider);
  const mode = recognizedMode(provider, body.mode, defaults.mode);
  const descriptor = tunnelModeCapability(provider, mode);
  const intent: TunnelIntent = descriptor.intent;
  const carried = body.intent;
  if (carried !== undefined && carried !== null && carried !== '') {
    const normalized = carried === 'ephemeral-public' || carried === 'persistent-public' || carried === 'private-network'
      ? carried
      : null;
    if (normalized !== intent) {
      throw new TunnelServiceError('validation_error', `Intent "${String(carried)}" does not match mode ${mode}`, 'intent/mode mismatch');
    }
  }
  return {
    provider,
    mode,
    intent,
    configPath: resolveTunnelConfigPath(body.configPath ?? defaults.configPath),
    token: resolveTunnelToken(body.token ?? defaults.token),
    hostname: resolveTunnelHostname(body.hostname ?? defaults.hostname),
  };
}
