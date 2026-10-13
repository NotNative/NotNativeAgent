// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { redeemDesktopPairingOverRelay } from './desktop-relay-pairing.ts';

describe('redeemDesktopPairingOverRelay', () => {
  it('preserves HTTP 429 as a retry-later error and closes the throwaway tunnel', async () => {
    const candidate = {
      type: 'relay' as const, relayUrl: 'wss://relay.example/ws', serverId: 'server-1',
      hostEncPubJwk: { kty: 'EC' as const, crv: 'P-256' as const, x: 'x', y: 'y' }, grant: 'one-time',
    };
    const close = vi.fn();
    const payload = {
      v: 2 as const, pairingId: 'pair-1', secret: 'one-time-secret',
      expiresAt: new Date(Date.now() + 60_000).toISOString(), candidates: [candidate],
    };
    const createClient = vi.fn(() => ({
      fetch: async () => new Response('{"error":"rate limited"}', { status: 429 }),
      close,
    } as never));

    await expect(redeemDesktopPairingOverRelay(payload, candidate, {
      installId: 'install-1', platform: 'win32', appVersion: '1.0.0',
    }, createClient)).rejects.toThrow('pairing-rate-limited');
    expect(createClient).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
