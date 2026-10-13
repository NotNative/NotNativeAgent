// SPDX-License-Identifier: Apache-2.0
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nativeFetch = vi.hoisted(() => {
  const mock = vi.fn();
  vi.stubGlobal('fetch', mock);
  return mock;
});
import { browserPushApi } from '../push-api.ts';
import { configureRuntimeUrlResolver } from '../runtime-url.ts';
import { setRuntimeBearerToken, setRuntimeExtraHeaders } from '../runtime-auth.ts';

const publicKey = `BA${'A'.repeat(85)}`;
const subscription = { endpoint: 'https://push.example/subscription', keys: { p256dh: 'key', auth: 'secret' } };
const respond = (body: unknown, status = 200) => nativeFetch.mockResolvedValue(new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  nativeFetch.mockReset();
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://first.example' });
  setRuntimeBearerToken('first-token');
  setRuntimeExtraHeaders({ 'x-device': 'browser' });
});
afterEach(() => {
  configureRuntimeUrlResolver({ apiBaseUrl: '' });
  setRuntimeBearerToken(null);
  setRuntimeExtraHeaders({});
});
afterAll(() => vi.unstubAllGlobals());

describe('browserPushApi', () => {
  it('validates ordered badge snapshots and acknowledges scoped resets using current credentials', async () => {
    const badge = { count: 3, epoch: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', revision: 7 };
    respond({ ok: true, badge });
    await expect(browserPushApi.getBadge!()).resolves.toEqual(badge);
    respond({ success: true, sessionId: 's1', messageSent: true, badge: { ...badge, count: 0, revision: 8 } });
    await expect(browserPushApi.resetBadge!('s1', 'message-sent')).resolves.toMatchObject({ count: 0, revision: 8 });
    const [url, init] = nativeFetch.mock.calls.at(-1)!;
    expect(url).toBe('https://first.example/api/sessions/s1/message-sent');
    expect(JSON.parse(init.body)).toEqual({});
    expect(init.headers.get('authorization')).toBe('Bearer first-token');
    expect(init.signal).toBeInstanceOf(AbortSignal); expect(init.keepalive).toBe(true);
    for (const invalid of [{ ...badge, count: -1 }, { ...badge, revision: 1.5 }, { ...badge, epoch: 'unknown' }]) {
      respond({ ok: true, badge: invalid }); await expect(browserPushApi.getBadge!()).rejects.toThrow('invalid');
    }
    respond({ success: false, badge }); await expect(browserPushApi.resetBadge!('s1', 'view')).rejects.toThrow('not confirmed');
  });
  it('uses the current instance and credentials on each request', async () => {
    respond({ publicKey });
    await expect(browserPushApi.getVapidPublicKey()).resolves.toEqual({ publicKey });
    configureRuntimeUrlResolver({ apiBaseUrl: 'https://second.example/' });
    setRuntimeBearerToken('second-token');
    respond({ ok: true });
    await browserPushApi.subscribe(subscription);
    const [url, init] = nativeFetch.mock.calls[1]!;
    expect(url).toBe('https://second.example/api/push/subscribe');
    expect(init.credentials).toBe('include');
    expect(init.headers.get('authorization')).toBe('Bearer second-token');
    expect(init.headers.get('x-device')).toBe('browser');
    expect(init.headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual(subscription);
  });

  it('uses the intended verbs and validates every mutation acknowledgement', async () => {
    for (const [operation, method, path, body] of [
      [() => browserPushApi.subscribe(subscription), 'POST', 'subscribe', subscription],
      [() => browserPushApi.unsubscribe({ endpoint: subscription.endpoint }), 'DELETE', 'subscribe', { endpoint: subscription.endpoint }],
      [() => browserPushApi.setVisibility({ visible: false }), 'POST', 'visibility', { visible: false }],
    ] as const) {
      respond({ ok: true });
      await expect(operation()).resolves.toEqual({ ok: true });
      const [url, init] = nativeFetch.mock.calls.at(-1)!;
      expect(url).toBe(`https://first.example/api/push/${path}`);
      expect(init.method).toBe(method);
      expect(JSON.parse(init.body)).toEqual(body);
      respond({ ok: false });
      await expect(operation()).rejects.toThrow('not confirmed');
    }
  });

  it('does not lose HTTP failure status when an error body is HTML', async () => {
    nativeFetch.mockResolvedValue(new Response('<html>Unavailable</html>', { status: 503 }));
    await expect(browserPushApi.getVapidPublicKey()).rejects.toThrow('Push request failed (503)');
  });

  it('rejects invalid or unreadable successful JSON', async () => {
    for (const body of [null, [], 'ok']) {
      respond(body);
      await expect(browserPushApi.getVisibility()).rejects.toThrow('Push response is invalid (200)');
    }
    nativeFetch.mockResolvedValue(new Response('not-json'));
    await expect(browserPushApi.getVisibility()).rejects.toThrow('Push response is invalid (200)');
    nativeFetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.reject(new Error('read failed')) });
    await expect(browserPushApi.getVisibility()).rejects.toThrow('Push response is invalid (200)');
  });

  it('requires a real visibility boolean and positive acknowledgement', async () => {
    for (const visible of [true, false]) {
      respond({ ok: true, visible });
      await expect(browserPushApi.getVisibility()).resolves.toEqual({ ok: true, visible });
    }
    for (const body of [{ ok: false, visible: true }, { ok: true, visible: 'false' }, { visible: true }]) {
      respond(body);
      await expect(browserPushApi.getVisibility()).rejects.toThrow('Push visibility is invalid');
    }
  });

  it('rejects wrong VAPID key length, encoding, or compressed-point prefix', async () => {
    for (const key of [null, '', `${publicKey}=`, 'A'.repeat(87), `BP${'A'.repeat(84)}B`]) {
      respond({ publicKey: key });
      await expect(browserPushApi.getVapidPublicKey()).rejects.toThrow('Push public key is invalid');
    }
    respond({ publicKey: `BP${'A'.repeat(85)}` });
    await expect(browserPushApi.getVapidPublicKey()).resolves.toEqual({ publicKey: `BP${'A'.repeat(85)}` });
  });

  it('propagates transport rejection without inventing a successful registration', async () => {
    nativeFetch.mockRejectedValue(new Error('offline'));
    await expect(browserPushApi.subscribe(subscription)).rejects.toThrow('offline');
  });
});
