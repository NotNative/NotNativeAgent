// SPDX-License-Identifier: Apache-2.0
/**
 * P8-8 invariants sweep (§12.1/§12.3 rows): the ui runtime credentials
 * live in module memory only and Authorization never reaches anything
 * but the header it authenticates. Pins: extra-header laundering drops
 * `Authorization` at the setRuntimeExtraHeaders parse side (runtimeConfig
 * already filters it at injection), the bearer stays memory-only between
 * initialize/set/apply, and credential seams reset cleanly for tests.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendAuthTokenToUrl,
  appendAuthTokenToUrlWithContext,
  applyRuntimeAuthHeaders,
  clearCachedUrlAuthToken,
  clearCachedUrlAuthTokenIfCurrent,
  getCurrentUrlToken,
  getUrlTokenContext,
  refreshRuntimeUrlAuthToken,
  initializeRuntimeCredentials,
  setRuntimeBearerToken,
  setRuntimeExtraHeaders,
} from '../runtime-auth.ts';
import { getInjectedRuntimeHeaders } from '../runtimeConfig.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  clearCachedUrlAuthToken();
  setRuntimeBearerToken(null);
  setRuntimeExtraHeaders({});
});

describe('URL token mint cancellation', () => {
  it('invalidates a cached URL token when credentials change', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      token: 'old', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }), { status: 200 })));
    expect(await appendAuthTokenToUrl('ws://localhost/stream')).toContain('nn_url_token=old');
    setRuntimeBearerToken('replacement');
    expect(getCurrentUrlToken()).toBeNull();
  });

  it('does not let an old socket failure clear a newer token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'old',
        expiresAt: new Date(Date.now() + 60_000).toISOString() }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'new',
        expiresAt: new Date(Date.now() + 60_000).toISOString() }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await appendAuthTokenToUrl('ws://old.example/stream');
    const oldContext = getUrlTokenContext();
    clearCachedUrlAuthToken();
    await appendAuthTokenToUrl('ws://new.example/stream');
    clearCachedUrlAuthTokenIfCurrent(oldContext);
    expect(getCurrentUrlToken()).toBe('new');
  });

  it('binds a socket URL to the token it actually carries across refresh', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'old',
        expiresAt: new Date(Date.now() + 60_000).toISOString() }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'new',
        expiresAt: new Date(Date.now() + 60_000).toISOString() }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await appendAuthTokenToUrl('ws://example.test/stream');
    const authorized = await appendAuthTokenToUrlWithContext('ws://example.test/stream');
    expect(authorized.url).toContain('nn_url_token=old');
    await refreshRuntimeUrlAuthToken();
    clearCachedUrlAuthTokenIfCurrent(authorized.context);
    expect(getCurrentUrlToken()).toBe('new');
  });

  it('does not let an older mint overwrite the token after an endpoint change', async () => {
    let finishOld!: (response: Response) => void;
    const old = new Promise<Response>((resolve) => { finishOld = resolve; });
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => old)
      .mockImplementationOnce(async () => new Response(JSON.stringify({
        token: 'new', expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const older = appendAuthTokenToUrl('ws://old.example/stream');
    const olderFailure = expect(older).rejects.toThrow('url_token_context_changed');
    clearCachedUrlAuthToken(); // runtime switch invalidates the old endpoint's in-flight mint
    expect(await appendAuthTokenToUrl('ws://new.example/stream')).toContain('nn_url_token=new');
    finishOld(new Response(JSON.stringify({ token: 'old',
      expiresAt: new Date(Date.now() + 60_000).toISOString() }), { status: 200 }));
    await olderFailure;
    expect(getCurrentUrlToken()).toBe('new');
  });

  it('does not start a mint for an already cancelled reconnect', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const abort = new AbortController();
    abort.abort(new Error('already_cancelled'));
    await expect(appendAuthTokenToUrl('ws://localhost/api/global/event/ws', abort.signal))
      .rejects.toThrow('already_cancelled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('releases a reconnect even when its token fetch ignores abort', async () => {
    let finish!: (response: Response) => void;
    const stalled = new Promise<Response>((resolve) => { finish = resolve; });
    vi.stubGlobal('fetch', vi.fn(() => stalled));
    const abort = new AbortController();
    const connecting = appendAuthTokenToUrl('ws://localhost/api/global/event/ws', abort.signal);
    abort.abort(new Error('reconnect_interrupted'));
    await expect(connecting).rejects.toThrow('reconnect_interrupted');
    finish(new Response(JSON.stringify({ token: 'late', expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      { status: 200, headers: { 'content-type': 'application/json' } }));
    await Promise.resolve();
    expect(getCurrentUrlToken()).toBeNull();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
});

describe('runtime credentials (§12.3 memory-only, no shared-stored token)', () => {
  it('setRuntimeExtraHeaders never keeps an Authorization entry (parse-side filter)', () => {
    setRuntimeExtraHeaders({ 'x-device': 'mobile', Authorization: 'Bearer stolen', authorization: 'Bearer stolen-lower' });
    const headers = applyRuntimeAuthHeaders(new Headers());
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-device')).toBe('mobile');
    expect(getInjectedRuntimeHeaders()).toEqual({}); // node surface: no window globals, empty in — same posture
  });

  it('bearer applies once and never leaves memory (no injection, no storage)', () => {
    applyRuntimeAuthHeaders(new Headers()); // initialize-runtime default is tokenless on the node surface
    setRuntimeBearerToken('oc_client_abc');
    const out = applyRuntimeAuthHeaders(new Headers());
    expect(out.get('authorization')).toBe('Bearer oc_client_abc');
    expect(applyRuntimeAuthHeaders(out).get('authorization')).toBe('Bearer oc_client_abc'); // set-once discipline
    const flushed = new Headers();
    flushed.set('authorization', 'Bearer existing');
    applyRuntimeAuthHeaders(flushed);
    expect(flushed.get('authorization')).toBe('Bearer existing'); // never overwrites a caller-set header
  });

  it('initializeRuntimeCredentials resolves tokenless without injected globals and accepts a later bearer', () => {
    initializeRuntimeCredentials();
    expect(applyRuntimeAuthHeaders(new Headers()).get('authorization')).toBeNull();
    setRuntimeBearerToken('oc_client_late');
    expect(applyRuntimeAuthHeaders(new Headers()).get('authorization')).toBe('Bearer oc_client_late');
  });
});
