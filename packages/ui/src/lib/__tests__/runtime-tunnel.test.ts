// SPDX-License-Identifier: Apache-2.0
// Relay runtime singleton tests (doc 08 §3.10 runtime-tunnel.ts + §6.0):
// byte-level descriptor equality reuses the live tunnel, adopt skips a
// second connect+handshake, and deactivate closes exactly once.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRelayTunnelClient } from '../relay/tunnel-client.ts';
import type { RelayTunnelClientOptions, RelayWireSocket } from '../relay/tunnel-client-types.ts';
import {
  activateRelayTunnel, adoptRelayTunnel, deactivateRelayTunnel, getActiveRelayDescriptor,
  getActiveRelayTunnel, getRelayTunnelStatus, isRelayModeActive, relayFetchOrThrow,
  subscribeRelayTunnelStatus, __resetRelayTunnelRuntimeForTests, type RelayDescriptor,
} from '../runtime-tunnel.ts';

class HangingSocket implements RelayWireSocket {
  readyState = 0;
  binaryType = 'arraybuffer';
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;
  closedBy: number | null = null;
  closed = false;
  send(): void { /* never opened; the runtime test needs no traffic */ }
  close(code = 1000): void {
    if (this.closed) return;
    this.closed = true;
    this.closedBy = code;
  }
}

const savedWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;

beforeEach(() => {
  (globalThis as { WebSocket?: unknown }).WebSocket = class HangingWS extends HangingSocket {};
  __resetRelayTunnelRuntimeForTests();
});

afterEach(() => {
  deactivateRelayTunnel();
  (globalThis as { WebSocket?: unknown }).WebSocket = savedWebSocket;
  __resetRelayTunnelRuntimeForTests();
});

const descriptorA: RelayDescriptor = {
  relayUrl: 'wss://relay.test/ws',
  serverId: 'sid-A',
  hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'xa', y: 'ya' },
  grant: 'one-time-grant',
};

describe('relay runtime singleton', () => {
  it('an equal re-activation reuses the live tunnel; status subscriptions see the current state', () => {
    const first = activateRelayTunnel(descriptorA);
    expect(getActiveRelayTunnel()).toBe(first);
    expect(isRelayModeActive()).toBe(true);
    expect(getActiveRelayDescriptor()?.serverId).toBe('sid-A');
    expect(getRelayTunnelStatus().state).toBe('connecting'); // the hanging wire never opens
    let seen: string | null = null;
    const unsubscribe = subscribeRelayTunnelStatus((status) => { seen = status.state; });
    expect(seen).toBe('connecting'); // subscribe replays the current status
    unsubscribe();
    const second = activateRelayTunnel({ ...descriptorA }); // byte-equal descriptor (grant identical)
    expect(second).toBe(first);
  });

  it('a different descriptor tears down the old tunnel and installs fresh', () => {
    const first = activateRelayTunnel(descriptorA);
    const second = activateRelayTunnel({
      relayUrl: 'wss://relay.other.test/ws',
      serverId: 'sid-B',
      hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'xa', y: 'ya' },
    });
    expect(second).not.toBe(first);
    expect(first.getStatus().state).toBe('idle'); // deactivate closed the previous client
    expect(getActiveRelayDescriptor()?.serverId).toBe('sid-B');
    // descriptor byte equality holds even when the JWK object identity differs:
    expect(activateRelayTunnel({ ...descriptorA, hostEncPubJwk: { ...descriptorA.hostEncPubJwk } })).toBe(
      activateRelayTunnel({ ...descriptorA, hostEncPubJwk: { ...descriptorA.hostEncPubJwk } }),
    );
  });

  it('relayFetchOrThrow refuses when inactive and drains the queued fetch on close', async () => {
    await expect(relayFetchOrThrow('/api/x')).rejects.toThrow(/relay tunnel is not active/);
    const active = activateRelayTunnel(descriptorA);
    const queued = relayFetchOrThrow('/api/config');
    active.close(); // close() drains waiters
    await expect(queued).rejects.toThrow(/relay tunnel is not connected/);
    await expect(relayFetchOrThrow('/api/config')).rejects.toThrow(/relay tunnel is not connected/);
    deactivateRelayTunnel();
    await expect(relayFetchOrThrow('/api/config')).rejects.toThrow(/relay tunnel is not active/);
  });

  it('adoptRelayTunnel registers an already-open client for immediate reuse', () => {
    const manual = createRelayTunnelClient({
      relayUrl: 'ws://relay.test/ws',
      serverId: 'sid-adopt',
      hostEncPubJwk: descriptorA.hostEncPubJwk,
      createWireSocket: (): RelayWireSocket => new HangingSocket(),
    } satisfies RelayTunnelClientOptions);
    const adopted = adoptRelayTunnel({ ...descriptorA, serverId: 'sid-adopt' }, manual);
    expect(adopted).toBe(manual);
    expect(getActiveRelayTunnel()).toBe(manual);
    expect(activateRelayTunnel({ ...descriptorA, serverId: 'sid-adopt' })).toBe(manual); // byte-equal adopt reuse
    deactivateRelayTunnel();
    expect(manual.getStatus().state).toBe('idle');
    expect(getActiveRelayTunnel()).toBeNull();
    expect(isRelayModeActive()).toBe(false);
  });
});
