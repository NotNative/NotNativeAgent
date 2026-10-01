// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const runtime = vi.hoisted(() => ({ key: 'local', endpoint: 'http://localhost:3000', push: {
  getVapidPublicKey: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(),
} }));
vi.mock('../api/registry.ts', () => ({ tryGetRuntimeAPIs: () => ({ push: runtime.push }) }));
vi.mock('../runtime-switch.ts', () => ({ getRuntimeKey: () => runtime.key, getApiBaseUrlActive: () => runtime.endpoint }));
import { browserPushAvailable, browserPushSubscribed, enableBrowserPush, disableBrowserPush } from '../browser-push.ts';

let subscription: { endpoint: string; toJSON: ReturnType<typeof vi.fn>; unsubscribe: ReturnType<typeof vi.fn> };
let registration: { scope: string; active: { scriptURL: string }; pushManager: { getSubscription: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> } };
let serviceWorker: { ready: Promise<unknown>; register: ReturnType<typeof vi.fn>; getRegistration: ReturnType<typeof vi.fn> };
let notification: { permission: string; requestPermission: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.clearAllMocks();
  runtime.key = 'local'; runtime.endpoint = window.location.origin;
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  subscription = { endpoint: 'https://push.example/destination', toJSON: vi.fn(() => ({ endpoint: 'https://push.example/destination', keys: { p256dh: 'key', auth: 'secret' } })), unsubscribe: vi.fn().mockResolvedValue(true) };
  registration = { scope: `${window.location.origin}/`, active: { scriptURL: `${window.location.origin}/service-worker.js` }, pushManager: {
    getSubscription: vi.fn().mockResolvedValue(subscription), subscribe: vi.fn().mockResolvedValue(subscription),
  } };
  serviceWorker = { ready: Promise.resolve(registration), register: vi.fn().mockResolvedValue(registration), getRegistration: vi.fn().mockResolvedValue(registration) };
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorker });
  notification = { permission: 'default', requestPermission: vi.fn().mockResolvedValue('granted') };
  vi.stubGlobal('Notification', notification);
  vi.stubGlobal('PushManager', class {});
  runtime.push.getVapidPublicKey.mockResolvedValue({ publicKey: btoa(String.fromCharCode(4) + 'x'.repeat(64)).replace(/=/gu, '') });
  runtime.push.subscribe.mockResolvedValue({ ok: true }); runtime.push.unsubscribe.mockResolvedValue({ ok: true });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('browser push registration', () => {
  it('requests permission before awaits and confirms the exact browser subscription with the server', async () => {
    const pending = enableBrowserPush();
    expect(notification.requestPermission).toHaveBeenCalledOnce();
    expect(serviceWorker.register).not.toHaveBeenCalled();
    await pending;
    expect(registration.pushManager.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true, applicationServerKey: expect.any(Uint8Array) }));
    expect(runtime.push.subscribe).toHaveBeenCalledWith({ endpoint: subscription.endpoint, keys: { p256dh: 'key', auth: 'secret' }, platform: 'web', origin: window.location.origin });
  });

  it('reads existing subscription without prompting or registering it', async () => {
    expect(await browserPushSubscribed()).toBe(true);
    expect(notification.requestPermission).not.toHaveBeenCalled();
    expect(runtime.push.subscribe).not.toHaveBeenCalled();
  });

  it('rejects subscription reads completed after changing connection', async () => {
    registration.pushManager.getSubscription.mockImplementation(async () => { runtime.endpoint = 'https://other.example'; return subscription; });
    await expect(browserPushSubscribed()).rejects.toThrow('changed');
  });

  it.each(['register', 'ready'])('releases a timed-out %s wait so a later user action can retry', async (stage) => {
    vi.useFakeTimers();
    if (stage === 'register') serviceWorker.register.mockImplementationOnce(() => new Promise(() => {}));
    else serviceWorker.ready = new Promise(() => {});
    const failed = expect(enableBrowserPush()).rejects.toThrow('did not become ready');
    await vi.advanceTimersByTimeAsync(15_000);
    await failed;
    expect(runtime.push.getVapidPublicKey).not.toHaveBeenCalled();
    serviceWorker.ready = Promise.resolve(registration);
    await expect(enableBrowserPush()).resolves.toBeUndefined();
  });

  it('does not subscribe after permission denial', async () => {
    notification.requestPermission.mockResolvedValue('denied');
    await expect(enableBrowserPush()).rejects.toThrow('not granted');
    expect(serviceWorker.register).not.toHaveBeenCalled();
  });

  it('blocks cross-origin connections and insecure browsers', async () => {
    runtime.endpoint = 'https://other.example';
    expect(browserPushAvailable()).toBe(false);
    await expect(enableBrowserPush()).rejects.toThrow('unavailable');
    expect(notification.requestPermission).not.toHaveBeenCalled();
    runtime.endpoint = window.location.origin;
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    expect(browserPushAvailable()).toBe(false);
  });

  it('stops before server registration when the runtime changes while the browser subscribes', async () => {
    registration.pushManager.subscribe.mockImplementation(async () => { runtime.key = 'other'; return subscription; });
    await expect(enableBrowserPush()).rejects.toThrow('changed');
    expect(runtime.push.subscribe).not.toHaveBeenCalled();
  });

  it('does not treat failed server registration as success and allows a retry', async () => {
    runtime.push.subscribe.mockRejectedValueOnce(new Error('disconnected'));
    await expect(enableBrowserPush()).rejects.toThrow('disconnected');
    await expect(enableBrowserPush()).resolves.toBeUndefined();
  });

  it('removes the server registration before unsubscribing and retains the browser subscription on server failure', async () => {
    runtime.push.unsubscribe.mockRejectedValueOnce(new Error('disconnected'));
    await expect(disableBrowserPush()).rejects.toThrow('disconnected');
    expect(subscription.unsubscribe).not.toHaveBeenCalled();
    await disableBrowserPush();
    expect(runtime.push.unsubscribe).toHaveBeenCalledWith({ endpoint: subscription.endpoint });
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
  });

  it('rejects unexpected workers and duplicate pending actions', async () => {
    registration.active.scriptURL = `${window.location.origin}/other-worker.js`;
    const pending = enableBrowserPush();
    await expect(enableBrowserPush()).rejects.toThrow('already running');
    await expect(pending).rejects.toThrow('Unexpected');
    expect(runtime.push.subscribe).not.toHaveBeenCalled();
  });
});
