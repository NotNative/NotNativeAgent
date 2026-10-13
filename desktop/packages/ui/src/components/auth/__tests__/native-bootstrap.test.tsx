// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NativeBootstrapFields, redeemNativeBootstrap } from '../NativeBootstrapFields.tsx';
import { GATE_TEXT } from '../gateText.ts';
import { createSessionGateRuntime, type SessionProbe } from '../../../lib/sessionAuthGateState.ts';
import { NO_SUPPORT, sessionGateView } from '../../../lib/sessionAuthGateView.ts';
import { applyRuntimeAuthHeaders, initializeRuntimeCredentials, setRuntimeBearerToken } from '../../../lib/runtime-auth.ts';

const target = vi.hoisted(() => ({ key: 'local', changed: null as (() => void) | null }));
vi.mock('../../../lib/runtime-switch.ts', () => ({
  getRuntimeKey: () => target.key,
  onRuntimeEndpointChanged: (callback: () => void) => { target.changed = callback; return () => { target.changed = null; }; },
}));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove(); root = undefined; container = undefined; target.key = 'local'; target.changed = null;
  delete window.__NOTNATIVE_CLIENT_TOKEN__; setRuntimeBearerToken(null);
});
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });
const probe: SessionProbe = { stage: 'locked', status: 401, authenticated: false, authRequired: true,
  methods: ['native-bootstrap'], tunnelLocked: false, retryAfterSeconds: null };
const presence = { known: false, hasPasskeys: false, passkeysDisabled: false };

describe('native UI access', () => {
  it('offers the native code only for the advertised local locked method', () => {
    expect(sessionGateView(probe, NO_SUPPORT, presence)).toMatchObject({ nativeBootstrapForm: true, passwordForm: false });
    for (const stage of ['authenticated', 'pending', 'error', 'tunnel-locked'] as const) {
      expect(sessionGateView({ ...probe, stage }, NO_SUPPORT, presence).nativeBootstrapForm).toBe(false);
    }
    expect(sessionGateView({ ...probe, methods: ['password'] }, NO_SUPPORT, presence).nativeBootstrapForm).toBe(false);
  });

  it('sends the code only in a POST body and confirms the resulting cookie session', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json(200, { authenticated: true })).mockResolvedValueOnce(json(200, { authenticated: true }));
    const runtime = createSessionGateRuntime({ fetch });
    expect(await redeemNativeBootstrap(runtime, 'test-code', new AbortController().signal)).toBe(true);
    expect(fetch.mock.calls[0]?.[0]).toBe('/auth/native-bootstrap');
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', body: '{"ticket":"test-code"}' });
    expect(fetch.mock.calls[1]?.[0]).toBe('/auth/session');
  });

  it('does not unlock if cookie admission fails or a success body is malformed', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json(200, { authenticated: true })).mockResolvedValueOnce(json(401, { locked: true }));
    expect(await redeemNativeBootstrap(createSessionGateRuntime({ fetch }), 'test-code', new AbortController().signal)).toBe(false);
    fetch.mockReset().mockResolvedValue(json(200, {}));
    expect(await redeemNativeBootstrap(createSessionGateRuntime({ fetch }), 'test-code', new AbortController().signal)).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('replaces a stale injected device bearer with the new cookie session', async () => {
    window.__NOTNATIVE_CLIENT_TOKEN__ = 'old-device-token';
    initializeRuntimeCredentials();
    expect(applyRuntimeAuthHeaders(new Headers()).get('authorization')).toBe('Bearer old-device-token');
    const fetch = vi.fn().mockImplementation(async () => json(200, { authenticated: true }));
    expect(await redeemNativeBootstrap(createSessionGateRuntime({ fetch }), 'test-code', new AbortController().signal)).toBe(true);
    expect(applyRuntimeAuthHeaders(new Headers()).has('authorization')).toBe(false);
  });

  it('clears entered codes and cancels pending redemption when the selected host changes', async () => {
    let complete!: (response: Response) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { complete = resolve; }))
      .mockResolvedValue(json(200, { authenticated: true }));
    const authenticated = vi.fn().mockResolvedValue(undefined);
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => root?.render(<NativeBootstrapFields runtime={createSessionGateRuntime({ fetch })}
      text={GATE_TEXT} onAuthenticated={authenticated} />));
    const input = container.querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'test-code');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => container!.querySelector('button')!.click());
    expect(fetch).toHaveBeenCalledTimes(1);
    const signal = fetch.mock.calls[0]?.[1]?.signal as AbortSignal;
    await act(async () => { target.key = 'host:other'; target.changed?.(); });
    expect(input.value).toBe(''); expect(signal.aborted).toBe(true);
    await act(async () => { complete(json(200, { authenticated: true })); });
    expect(authenticated).not.toHaveBeenCalled();
  });
});
