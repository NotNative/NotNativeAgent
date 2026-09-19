// SPDX-License-Identifier: Apache-2.0
/**
 * Relay tunnel runtime singleton (doc 08 §3.10 runtime integration).
 * `activateRelayTunnel(descriptor)` reuses an EQUAL descriptor instead of
 * tearing down a live tunnel (equality is byte-level: relayUrl, serverId,
 * grant, canonical JWK JSON); `adoptRelayTunnel` adopts an already-open
 * probe tunnel so the immediately following activate call reuses it (one
 * WS connect + one handshake saved); `deactivateRelayTunnel` closes the
 * live client. Instance switching carries the transport; the runtime key
 * (not this file) owns instance identity.
 */
import { createRelayTunnelClient } from './relay/tunnel-client.ts';
import type { RelayTunnelClient, RelayTunnelStatus } from './relay/tunnel-client-types.ts';

export interface RelayDescriptor {
  relayUrl: string;
  serverId: string;
  hostEncPubJwk: { kty: string; crv: string; x: string; y: string };
  /** One-time pairing artifact: memory-only, never persisted (§3.3). */
  grant?: string;
}

type StatusListener = (status: RelayTunnelStatus) => void;

let activeDescriptor: RelayDescriptor | null = null;
let activeClient: RelayTunnelClient | null = null;
let lastStatus: RelayTunnelStatus = { state: 'idle' };
const statusListeners = new Set<StatusListener>();

/** Canonical JWK JSON for the byte-level equality rule (§6.0). */
function canonicalJwk(jwk: RelayDescriptor['hostEncPubJwk']): string {
  return JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
}

function descriptorsEqual(a: RelayDescriptor, b: RelayDescriptor): boolean {
  return a.relayUrl === b.relayUrl && a.serverId === b.serverId
    && (a.grant ?? '') === (b.grant ?? '')
    && canonicalJwk(a.hostEncPubJwk) === canonicalJwk(b.hostEncPubJwk);
}

function clientFor(descriptor: RelayDescriptor): RelayTunnelClient {
  const client = createRelayTunnelClient({
    relayUrl: descriptor.relayUrl,
    serverId: descriptor.serverId,
    hostEncPubJwk: descriptor.hostEncPubJwk,
    grant: descriptor.grant,
    platform: typeof window !== 'undefined' ? window.__NOTNATIVE_SURFACE__ ?? 'web' : 'web',
    wakeHooks: {
      isOnline: () => typeof navigator === 'undefined' ? true : navigator.onLine,
      isHidden: () => typeof document === 'undefined' ? false : document.visibilityState === 'hidden',
      onWake: (cb) => {
        if (typeof window === 'undefined') return () => undefined;
        window.addEventListener('online', cb);
        const onVisible = (): void => {
          if (document.visibilityState === 'visible') cb();
        };
        window.addEventListener('visibilitychange', onVisible);
        return () => {
          window.removeEventListener('online', cb);
          window.removeEventListener('visibilitychange', onVisible);
        };
      },
    },
  });
  return client;
}

/** Status fan-out shared by created and adopted tunnels (an ADOPTED probe
 * tunnel stays status-visible for the banner/switch, §3.11/§6.2). */
function wireClientStatus(client: RelayTunnelClient): void {
  client.subscribeStatus((status) => {
    lastStatus = status;
    for (const listener of [...statusListeners]) {
      try { listener(status); } catch { /* listeners never break the tunnel */ }
    }
  });
}

export function activateRelayTunnel(descriptor: RelayDescriptor): RelayTunnelClient {
  if (activeDescriptor !== null && activeClient !== null && descriptorsEqual(activeDescriptor, descriptor)) {
    // An equal re-activate reuses the LIVE tunnel; a terminal-failed
    // tunnel (4010/4002/4029 retained, §3.11) is not live and would wedge
    // every future hot-switch, so it is replaced with a fresh client.
    if (activeClient.getStatus().state !== 'error') return activeClient;
  }
  deactivateRelayTunnel();
  activeDescriptor = descriptor;
  activeClient = clientFor(descriptor);
  wireClientStatus(activeClient);
  return activeClient;
}

/** Registers an already-open client (a probe tunnel) for immediate reuse. */
export function adoptRelayTunnel(descriptor: RelayDescriptor, client: RelayTunnelClient): RelayTunnelClient {
  if (activeDescriptor !== null && activeClient !== null && descriptorsEqual(activeDescriptor, descriptor)
    && activeClient.getStatus().state !== 'error') {
    return activeClient;
  }
  deactivateRelayTunnel();
  activeDescriptor = descriptor;
  activeClient = client;
  wireClientStatus(client);
  lastStatus = client.getStatus();
  return activeClient;
}

export function deactivateRelayTunnel(): void {
  if (activeClient === null) { activeDescriptor = null; return; }
  try { activeClient.close(); } catch { /* close is idempotent on the client */ }
  activeClient = null;
  activeDescriptor = null;
  lastStatus = { state: 'idle' };
}

export function getActiveRelayTunnel(): RelayTunnelClient | null {
  return activeClient;
}

export function getActiveRelayDescriptor(): RelayDescriptor | null {
  return activeDescriptor;
}

export function isRelayModeActive(): boolean {
  return activeClient !== null;
}

export function getRelayTunnelStatus(): RelayTunnelStatus {
  return activeClient?.getStatus() ?? lastStatus;
}

export function relayFetchOrThrow(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const client = activeClient;
  if (client === null) return Promise.reject(new Error('relay tunnel is not active'));
  return client.fetch(input, init);
}

export function subscribeRelayTunnelStatus(listener: StatusListener): () => void {
  statusListeners.add(listener);
  listener(lastStatus);
  return () => { statusListeners.delete(listener); };
}

/** Test/media reset only; production code goes through the activate/deactivate API. */
export function __resetRelayTunnelRuntimeForTests(): void {
  activeDescriptor = null;
  activeClient = null;
  lastStatus = { state: 'idle' };
  statusListeners.clear();
}
