// SPDX-License-Identifier: Apache-2.0
/** P11-24 §H.4 decision table and endpoint-cache invalidation. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DevTunnelUnavailableError, devTunnelMetrics, installDevTunnelRuntimeInvalidation,
  isLoopbackHost, resetDevTunnelCache, resolveBrowsableUrl, setDesktopTunnelBridge,
  shouldTunnelLoopbackUrl, toDisplayUrl,
} from '../dev-tunnel.ts';
import { switchRuntimeEndpoint } from '../../runtime-switch.ts';

const runtime = { isDesktop: true, runtimeBaseUrl: 'https://remote.example.invalid/api', localOrigin: 'http://127.0.0.1:41800' };
function bridge(ports: number[] = [41001], failure = false): { open: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  let openCount = -1;
  return {
    open: vi.fn(async () => {
      if (failure) throw new Error('refused');
      openCount += 1;
      return { localPort: ports[openCount] ?? 41001 + openCount, reused: openCount > 0, url: '' };
    }),
    close: vi.fn(() => ({ closed: true })),
  };
}

vi.mock('../runtime-url.ts', () => ({ configureRuntimeUrlResolver: vi.fn() }));
vi.mock('../runtime-auth.ts', () => ({
  setRuntimeBearerToken: vi.fn(),
  setRuntimeExtraHeaders: vi.fn(),
  refreshRuntimeUrlAuthToken: vi.fn(async () => undefined),
}));
vi.mock('../runtime-tunnel.ts', () => ({
  activateRelayTunnel: vi.fn(),
  deactivateRelayTunnel: vi.fn(),
}));

describe('dev-tunnel panel decisions', () => {
  afterEach(() => {
    setDesktopTunnelBridge(null);
    resetDevTunnelCache();
  });

  it('classifies loopback targets across localhost, IPv4, IPv6, and DNS dot', () => {
    expect([ 'localhost', '127.0.0.2', '0.0.0.0', '[::1]', 'localhost.' ].map((host) => isLoopbackHost(host))).toEqual([true, true, true, true, true]);
  });

  it('leaves non-desktop, non-loopback, and local-runtime URLs unchanged', async () => {
    const proxy = bridge();
    setDesktopTunnelBridge(proxy as never);
    await expect(resolveBrowsableUrl('https://example.invalid/path', runtime)).resolves.toBe('https://example.invalid/path');
    await expect(resolveBrowsableUrl('http://localhost:5173/path', { ...runtime, isDesktop: false })).resolves.toBe('http://localhost:5173/path');
    await expect(resolveBrowsableUrl('http://localhost:5173/path', { ...runtime, runtimeBaseUrl: 'http://localhost:5173' })).resolves.toBe('http://localhost:5173/path');
    await expect(resolveBrowsableUrl('http://localhost:5173/path', { ...runtime, runtimeBaseUrl: 'http://other.example.invalid', localOrigin: 'http://other.example.invalid' })).resolves.toBe('http://localhost:5173/path');
    expect(proxy.open).not.toHaveBeenCalled();
  });

  it('preserves the requested port when reusing a mapped port', async () => {
    const proxy = bridge();
    setDesktopTunnelBridge(proxy as never);
    const first = await resolveBrowsableUrl('http://localhost:4200/first', runtime);
    const second = await resolveBrowsableUrl('http://localhost:4200/second', runtime);
    expect(new URL(second).port).toBe(new URL(first).port);
    expect((proxy.open as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      [{ baseUrl: 'https://remote.example.invalid/api', port: 4200 }],
    ]);
  });

  it('maps implicit ports and reuses one cache per baseUrl|port', async () => {
    const proxy = bridge();
    setDesktopTunnelBridge(proxy as never);
    const first = await resolveBrowsableUrl('http://localhost/path?a=1', runtime);
    const second = await resolveBrowsableUrl('http://127.0.0.1/other#hash', runtime);
    const secure = await resolveBrowsableUrl('https://localhost/', { ...runtime, runtimeBaseUrl: 'https://other.example.invalid/api' });
    expect(first).toBe(`http://127.0.0.1:41001/path?a=1`);
    expect(second).toBe(`http://127.0.0.1:41001/other#hash`);
    expect(secure).toBe(`https://127.0.0.1:41002/`);
    expect(proxy.open).toHaveBeenCalledTimes(2);
    expect(proxy.open).toHaveBeenCalledWith({ baseUrl: 'https://remote.example.invalid/api', port: 80 });
    expect(proxy.open).toHaveBeenCalledWith({ baseUrl: 'https://other.example.invalid/api', port: 443 });
    expect(devTunnelMetrics()).toEqual({ cache: 2, mappedPorts: 2 });
  });

  it('skips retargets through a mapped tunnel port and restores display URLs', async () => {
    const proxy = bridge();
    setDesktopTunnelBridge(proxy as never);
    const mapped = await resolveBrowsableUrl('http://localhost/', runtime);
    const localPort = Number(new URL(mapped).port);
    expect(shouldTunnelLoopbackUrl(mapped, runtime)).toBe(false);
    expect(shouldTunnelLoopbackUrl('http://localhost/docs', runtime)).toBe(true);
    expect(toDisplayUrl(mapped, runtime)).toBe('http://localhost/');
    expect(toDisplayUrl(`http://[::1]:${localPort}/v6?x=1`, runtime)).toBe('http://localhost/v6?x=1');
    expect(proxy.open).toHaveBeenCalledOnce();
  });

  it('never falls back to the plain loopback URL when bridging fails', async () => {
    const proxy = bridge([], true);
    setDesktopTunnelBridge(proxy as never);
    await expect(resolveBrowsableUrl('http://localhost:5173', runtime)).rejects.toBeInstanceOf(DevTunnelUnavailableError);
    expect(toDisplayUrl('http://localhost:5173', runtime)).toBe('http://localhost:5173');
    expect(devTunnelMetrics().cache).toBe(0);
  });

  it('requires an installed desktop bridge for remote runtime targets', async () => {
    await expect(resolveBrowsableUrl('http://localhost/', runtime)).rejects.toBeInstanceOf(DevTunnelUnavailableError);
  });

  it('clears mapped ports when the runtime endpoint changes', async () => {
    const proxy = bridge();
    setDesktopTunnelBridge(proxy as never);
    const unsubscribe = installDevTunnelRuntimeInvalidation();
    await resolveBrowsableUrl('http://localhost/', runtime);
    expect(devTunnelMetrics().cache).toBe(1);
    vi.stubGlobal('CustomEvent', class {});
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    try {
      await switchRuntimeEndpoint({ apiBaseUrl: 'https://alternate.example.invalid/api', runtimeKey: 'host:alternate' });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(devTunnelMetrics()).toEqual({ cache: 0, mappedPorts: 0 });
    expect(proxy.close).toHaveBeenCalledWith({ baseUrl: 'https://remote.example.invalid/api', port: 80 });
    unsubscribe();
  });

  it('discards an in-flight mapping after an endpoint switch', async () => {
    let release: (result: unknown) => void = () => {};
    const proxy = {
      open: vi.fn(() => new Promise((resolve) => { release = resolve; })),
      close: vi.fn(() => ({ closed: true })),
    };
    setDesktopTunnelBridge(proxy as never);
    const unsubscribe = installDevTunnelRuntimeInvalidation();
    const inFlight = resolveBrowsableUrl('http://localhost/', runtime);
    for (let attempt = 0; (proxy.open as ReturnType<typeof vi.fn>).mock.calls.length === 0; attempt += 1) {
      if (attempt >= 100) throw new Error('bridge was not opened');
      await new Promise((resolve) => setTimeout(resolve, 1, { signal: AbortSignal.timeout(1000) }));
    }
    vi.stubGlobal('CustomEvent', class {});
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    try {
      await switchRuntimeEndpoint({ apiBaseUrl: 'https://alternate.example.invalid/api', runtimeKey: 'host:alternate' });
    } finally {
      vi.unstubAllGlobals();
    }
    release({ localPort: 41001, reused: false, url: 'http://127.0.0.1:41001/' });
    await expect(inFlight).rejects.toBeInstanceOf(DevTunnelUnavailableError);
    expect(devTunnelMetrics()).toEqual({ cache: 0, mappedPorts: 0 });
    expect(proxy.close).toHaveBeenCalledWith({ baseUrl: 'https://remote.example.invalid/api', port: 80 });
    unsubscribe();
  });
});
