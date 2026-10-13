// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopRelayPairingBridge } from '../DesktopRelayPairingBridge.tsx';

const redeemOverRelay = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/desktop-relay-pairing.ts', () => ({
  redeemDesktopPairingOverRelay: redeemOverRelay,
}));

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

describe('DesktopRelayPairingBridge', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let onRequest: ((request: { requestId: string; payload: unknown; candidate: unknown; installId: string; platform: string; version: string }) => void) | undefined;
  const complete = vi.fn(async (_command: string, _payload: unknown) => ({ ok: true }));

  async function mount(): Promise<void> {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('window', {
      __NOTNATIVE_DESKTOP_INVOKE__: complete,
      __NOTNATIVE_DESKTOP_EVENTS__: {
        onRelayPairingRequest: (handler: typeof onRequest) => { onRequest = handler; return () => { onRequest = undefined; }; },
      },
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root?.render(<DesktopRelayPairingBridge />); });
  }

  async function send(requestId: string, expiresAt = new Date(Date.now() + 60_000).toISOString()): Promise<void> {
    await act(async () => {
      onRequest?.({
        requestId,
        payload: {
          v: 2, pairingId: 'pair-1', secret: 'one-time', expiresAt,
          candidates: [{ type: 'relay', relayUrl: 'wss://relay.example/ws', serverId: 'server-1',
            hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } }],
        },
        candidate: { type: 'relay', relayUrl: 'wss://relay.example/ws', serverId: 'server-1',
          hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } },
        installId: 'install', platform: 'win32', version: '1.0.0',
      });
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    onRequest = undefined;
    complete.mockClear();
    redeemOverRelay.mockReset();
    vi.unstubAllGlobals();
  });

  it('returns only the redeemed token and server label to main', async () => {
    redeemOverRelay.mockResolvedValue({ clientToken: 'client-token', serverLabel: 'Studio', relay: { grant: 'must-not-cross-ipc' } });
    await mount();
    await send('success-request');
    expect(complete).toHaveBeenCalledWith('desktop_pairing_redeem_relay_complete', {
      requestId: 'success-request', result: { ok: true, clientToken: 'client-token', serverLabel: 'Studio' },
    });
  });

  it('sanitizes unexpected relay errors before returning them to main', async () => {
    redeemOverRelay.mockRejectedValue(new Error('secret or internal transport detail'));
    await mount();
    await send('failure-request');
    expect(complete).toHaveBeenCalledWith('desktop_pairing_redeem_relay_complete', {
      requestId: 'failure-request', result: { ok: false, error: 'relay-failed' },
    });
  });

  it('preserves a relay rate-limit result for the native retry prompt', async () => {
    redeemOverRelay.mockRejectedValue(new Error('pairing-rate-limited'));
    await mount();
    await send('limited-request');
    expect(complete).toHaveBeenCalledWith('desktop_pairing_redeem_relay_complete', {
      requestId: 'limited-request', result: { ok: false, error: 'pairing-rate-limited' },
    });
  });

  it('reports a pairing offer that expired while waiting for the renderer', async () => {
    await mount();
    await send('expired-request', new Date(Date.now() - 1_000).toISOString());
    expect(complete).toHaveBeenCalledWith('desktop_pairing_redeem_relay_complete', {
      requestId: 'expired-request', result: { ok: false, error: 'pairing-expired' },
    });
  });
});
