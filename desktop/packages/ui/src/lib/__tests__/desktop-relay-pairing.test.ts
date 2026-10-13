// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { redeemDesktopPairingOverRelay } from '../desktop-relay-pairing.ts';
import type { PairingCandidate, PairingConnectionPayload } from '../connection-payload.ts';
import type { RelayTunnelClient } from '../relay/tunnel-client-types.ts';

const relay = {
  type: 'relay', relayUrl: 'wss://relay.example/ws', serverId: 'server-1',
  hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }, grant: 'one-time-grant',
} satisfies Extract<PairingCandidate, { type: 'relay' }>;
const payload = {
  v: 2, pairingId: 'pair-1', secret: 'pairing-secret', expiresAt: new Date(Date.now() + 60_000).toISOString(),
  candidates: [relay],
} satisfies PairingConnectionPayload;
const identity = { installId: 'install-1', platform: 'win32', appVersion: '20260930.0.47' };

function fakeClient(fetch: RelayTunnelClient['fetch']): RelayTunnelClient & { close: ReturnType<typeof vi.fn> } {
  return {
    fetch,
    openWebSocket: vi.fn(),
    getStatus: () => ({ state: 'connected' }),
    subscribeStatus: vi.fn(() => () => undefined),
    close: vi.fn(),
  };
}

describe('desktop relay pairing redemption', () => {
  it('redeems over the encrypted tunnel and returns only the steady-state public descriptor', async () => {
    const client = fakeClient(vi.fn(async (input, init) => {
      expect(input).toBe('/api/client-auth/pairing/redeem');
      expect(init?.method).toBe('POST');
      const sent = JSON.parse(String(init?.body));
      expect(sent).toMatchObject({ pairingId: 'pair-1', secret: 'pairing-secret', dedupeKey: 'desktop:install-1' });
      return Response.json({ ok: true, clientToken: 'issued-token', server: { label: 'Studio' } });
    }));
    const factory = vi.fn(() => client);
    const result = await redeemDesktopPairingOverRelay(payload, relay, identity, factory);
    expect(factory).toHaveBeenCalledWith(relay);
    expect(result).toEqual({
      clientToken: 'issued-token', serverLabel: 'Studio',
      relay: { relayUrl: relay.relayUrl, serverId: relay.serverId, hostEncPubJwk: relay.hostEncPubJwk },
    });
    expect(result.relay).not.toHaveProperty('grant');
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('closes the tunnel when redemption fails and does not accept malformed tokens', async () => {
    const client = fakeClient(vi.fn(async () => Response.json({ ok: true, clientToken: 'bad\ntoken' })));
    await expect(redeemDesktopPairingOverRelay(payload, relay, identity, () => client)).rejects.toThrow('pairing-rejected');
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('rejects expired input before opening a tunnel', async () => {
    const factory = vi.fn();
    await expect(redeemDesktopPairingOverRelay({ ...payload, expiresAt: new Date(0).toISOString() }, relay, identity, factory))
      .rejects.toThrow('pairing-expired');
    expect(factory).not.toHaveBeenCalled();
  });

  it('rejects an invalid expiry and a relay identity not advertised by the consented link', async () => {
    const factory = vi.fn();
    await expect(redeemDesktopPairingOverRelay({ ...payload, expiresAt: 'not-a-date' }, relay, identity, factory))
      .rejects.toThrow('pairing-expired');
    await expect(redeemDesktopPairingOverRelay(payload, {
      ...relay, serverId: 'attacker-server', hostEncPubJwk: { ...relay.hostEncPubJwk, x: 'attacker-key' },
    }, identity, factory)).rejects.toThrow('pairing-candidate-mismatch');
    expect(factory).not.toHaveBeenCalled();
  });

  it('bounds streamed response size before parsing', async () => {
    const oversized = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(65 * 1024)); controller.close(); },
    }));
    const client = fakeClient(vi.fn(async () => oversized));
    await expect(redeemDesktopPairingOverRelay(payload, relay, identity, () => client)).rejects.toThrow('response-too-large');
    expect(client.close).toHaveBeenCalledOnce();
  });
});
