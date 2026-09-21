// SPDX-License-Identifier: Apache-2.0
/**
 * connect-url server-URL resolution + candidate math (doc 08 S5.9). The
 * resolution order is exact: explicit --server (normalized http/https,
 * invalid = usage error) > --host/env full-URL passthrough (a remote deploy
 * behind a proxy) > concrete non-loopback host = http://<host>:<port> >
 * wildcard bind = LAN IPv4 (source lan-detected) > loopback fallback.
 * Candidates: one direct (priority 10, https => tunnel) plus the relay
 * when --relay was requested OR the host relay is enabled.
 */
import { ENV } from '../server/env.ts';
import {
  isLoopbackHostname,
  isLoopbackUrl,
  lanIpv4FromInterfaces,
} from '../server/lib/auth/pairing-candidates.ts';
import { DEFAULT_RELAY_URL, RelayConfigStore, readEnvRelayUrl } from '../server/lib/relay/relay-config.ts';
import {
  publicJwkCanonical,
  serverIdFromJwk,
  type RelayIdentity,
} from '../server/lib/relay/identity.ts';
import {
  PRIORITY_RELAY,
  normalizeRelayJwk as normalizeUiRelayJwk,
  type PairingCandidate,
} from '@notnative/ui/lib/connection-payload.ts';
import { CliUsageError } from './args.ts';
import type { ServerTarget } from './instances.ts';

const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '::ffff:0.0.0.0', '0000:0000:0000:0000:0000:0000:0000:0000']);

export interface UrlResolutionInput {
  port: number;
  serverFlag?: string;
  hostFlag?: string;
  lanFlag?: boolean;
  /** Interface-scan seam (tests); defaults to the real os scan. */
  lanScan?: () => string | null;
}

export interface RelaySourceInput {
  relayFlag: boolean;
  configEnabled: boolean;
  configRelayUrl: string | null;
}

export interface RelayResolution {
  relayUrl: string;
  fromEnv: boolean;
}

/** S5.9 relay endpoint chain: NOTNATIVE_RELAY_URL env > stored relayUrl >
 *  default endpoint (the same chain the host service rides). */
export function resolveRelayEndpoint(input: RelaySourceInput): RelayResolution {
  const env = readEnvRelayUrl();
  if (env !== null) return { relayUrl: env, fromEnv: true };
  return { relayUrl: input.configRelayUrl ?? DEFAULT_RELAY_URL, fromEnv: false };
}

/** Relay rides when the operator ASKED (--relay) or the relay is on. */
export function relayShouldBeIncluded(input: RelaySourceInput): boolean {
  return input.relayFlag === true || input.configEnabled === true;
}

/** S5.9 explicit --server / --host <URL> normalization: http(s) only, hash
 *  stripped, trailing "/" runs stripped. The WHATWG serializer lowercases the
 *  scheme + hostname (so `HTTPS://FOO/` advertises as a small-case https
 *  tunnel candidate, not a mistyped lan one). */
function normalizeServerFlag(value: string): string | null {
  const cleaned = (value.split('#')[0] ?? value).trim();
  if (!/^https?:\/\//iu.test(cleaned)) return null;
  try {
    const parsed = new URL(cleaned);
    if (parsed.hostname === '') return null;
    return parsed.toString().replace(/\/+$/u, '');
  } catch {
    return null;
  }
}

function hostVariant(host: string, port: number, lanScan: () => string | null): ServerTarget {
  const bare = host.toLowerCase().replace(/^\[|\]$/gu, '');
  if (WILDCARD_HOSTS.has(bare)) {
    return lanOrFallback(port, lanScan);
  }
  if (isLoopbackHostname(bare)) {
    return { port, host: '127.0.0.1', serverUrl: `http://127.0.0.1:${port}`, source: 'loopback-fallback' };
  }
  // A host token is an ADDRESS, never a URL fragment; IPv6 literals ride in
  // brackets inside the advertised URL. Garbage must die here (usage exit 2),
  // not leak into a candidate the device cannot parse.
  if (/[/@?#%]/u.test(host)) {
    throw new CliUsageError(`--host is not a usable address: "${host}"`);
  }
  const serverUrl = `http://${bare.includes(':') ? `[${bare}]` : host}:${port}`;
  try {
    const parsed = new URL(serverUrl);
    return { port, host, serverUrl: parsed.toString().replace(/\/+$/u, ''), source: 'configured' };
  } catch {
    throw new CliUsageError(`--host is not a usable address: "${host}" (URL parse failed)`);
  }
}

function lanOrFallback(port: number, lanScan: () => string | null, bindHost = '0.0.0.0'): ServerTarget {
  const lan = lanScan();
  if (lan !== null) {
    return { port, host: bindHost, serverUrl: `http://${lan}:${port}`, source: 'lan-detected' };
  }
  return { port, host: bindHost, serverUrl: `http://127.0.0.1:${port}`, source: 'loopback-fallback' };
}

/** S5.9 resolution order, including the --lan flag (= host 0.0.0.0) and the
 *  NOTNATIVE_HOST env fallback (ENV.host; absent = the loopback default). */
export function resolveServerTarget(input: UrlResolutionInput): ServerTarget {
  const lanScan = input.lanScan ?? lanIpv4FromInterfaces;
  if (input.serverFlag !== undefined) {
    const normalized = normalizeServerFlag(input.serverFlag);
    if (normalized === null) {
      throw new CliUsageError('--server expects a full http:// or https:// URL ');
    }
    // The spawned local instance always binds loopback; --server only names
    // the ADVERTISED public URL (a remote deploy behind a proxy, S5.9.2).
    return { port: input.port, host: '127.0.0.1', serverUrl: normalized, source: 'explicit' };
  }
  const host = (input.lanFlag === true ? '0.0.0.0' : input.hostFlag) ?? ENV.host ?? '';
  if (host === '') {
    return hostVariant('127.0.0.1', input.port, lanScan);
  }
  if (/^https?:\/\//iu.test(host)) {
    const normalized = normalizeServerFlag(host);
    if (normalized === null) throw new CliUsageError('--host with a URL expects a full http(s) URL');
    return { port: input.port, host: '127.0.0.1', serverUrl: normalized, source: 'configured' };
  }
  return hostVariant(host, input.port, lanScan);
}

/** S5.9: the relay candidate mints from the same shared identity runtime the
 *  host uses — lazy generation against <data-dir>/relay-identity.json, copied
 *  atomic-write + strict-read semantics (a corrupt file throws, never regen). */
export async function buildRelayCandidate(identity: RelayIdentity, relayUrl: string): Promise<PairingCandidate> {
  const jwk = normalizeUiRelayJwk(publicJwkCanonical(identity.encryption.publicJwk));
  if (jwk === null) throw new Error('relay identity encryption JWK did not normalize');
  return {
    type: 'relay',
    relayUrl,
    serverId: serverIdFromJwk(identity.signing.publicJwk),
    hostEncPubJwk: jwk,
    priority: PRIORITY_RELAY,
  };
}

export function directCandidate(serverUrl: string): PairingCandidate {
  return {
    type: serverUrl.startsWith('https://') ? 'tunnel' : 'lan',
    url: serverUrl,
    priority: 10,
  };
}

/** Direct candidate is loopback => the interactive advisory (S5.9). */
export function directIsLoopback(serverUrl: string): boolean {
  return isLoopbackUrl(serverUrl);
}

export function relayConfigFor(dataDir: string): { enabled: boolean; relayUrl: string | null; corrupt: boolean } {
  const config = new RelayConfigStore(dataDir).read();
  return { enabled: config.enabled, relayUrl: config.relayUrl, corrupt: config.corrupt };
}
