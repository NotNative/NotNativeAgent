// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BrowserSurface, canEmbedDesktopPreview, canPreviewDiscoveredServers } from '../browser-surface.tsx';

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean | undefined; }
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const originalFetch = globalThis.fetch;
afterEach(() => { act(() => root?.unmount()); container?.remove(); root = null; container = null;
  globalThis.fetch = originalFetch; delete window.__NOTNATIVE_ELECTRON__; delete window.__NOTNATIVE_BROWSER_CONTROL__;
  vi.useRealTimers(); });

function render(visible = true): HTMLElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<BrowserSurface visible={visible} />));
  return container;
}

function setVisible(visible: boolean): void {
  act(() => root!.render(<BrowserSurface visible={visible} />));
}

function enter(address: string): void {
  const input = container!.querySelector('input[aria-label="Preview address"]') as HTMLInputElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, address);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => container!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}

function readyFetch(): void {
  globalThis.fetch = vi.fn().mockImplementation(async (url: string) => url === '/api/system/probe-url'
    ? { ok: true, json: async () => ({ ok: true, status: 200 }) }
    : { ok: true, json: async () => ({ servers: [] }) });
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); });
}

describe('BrowserSurface', () => {
  it('binds broker requests only in the desktop pane and claims before opening or snapshotting', async () => {
    window.__NOTNATIVE_ELECTRON__ = { runtime: 'electron', arch: 'x64', trayEnabled: false };
    let onRequest!: (request: { requestId: string; action: string; parameters: Record<string, unknown> }) => void;
    const face = {
      register: vi.fn().mockResolvedValue({ ok: true }), unregister: vi.fn().mockResolvedValue({ ok: true }),
      claim: vi.fn().mockResolvedValue({ ok: true, result: { granted: true } }),
      result: vi.fn().mockResolvedValue({ ok: true, result: { matched: true } }),
      onRequest: vi.fn((handler: typeof onRequest) => { onRequest = handler; return () => undefined; }),
    };
    window.__NOTNATIVE_BROWSER_CONTROL__ = face;
    readyFetch();
    const view = render();
    expect(face.register).toHaveBeenCalledOnce();
    const openId = 'browser-00000000-0000-0000-0000-000000000001';
    await act(async () => { onRequest({ requestId: openId, action: 'browser.open', parameters: { url: 'https://example.org/' } });
      await Promise.resolve(); await Promise.resolve(); });
    expect(face.claim).toHaveBeenCalledWith(openId);
    expect(face.result).toHaveBeenCalledWith(openId, { ok: true,
      data: { url: 'https://example.org/', opened: true, settled: false } });
    const guest = view.querySelector('webview') as HTMLElement & { executeJavaScript?: ReturnType<typeof vi.fn> };
    expect(guest.getAttribute('src')).toBe('https://example.org/');
    guest.executeJavaScript = vi.fn().mockResolvedValue({ url: 'https://example.org/', title: 'Example', text: 'Ready',
      textTotalChars: 5, textTruncated: false, elements: [], interactiveElementsOnPage: 0, elementsTruncated: false });
    const snapshotId = 'browser-00000000-0000-0000-0000-000000000002';
    await act(async () => { onRequest({ requestId: snapshotId, action: 'browser.snapshot', parameters: {} });
      await Promise.resolve(); await Promise.resolve(); });
    expect(guest.executeJavaScript).toHaveBeenCalledOnce();
    expect(face.result).toHaveBeenCalledWith(snapshotId, { ok: true, data: expect.objectContaining({ title: 'Example' }) });
    guest.executeJavaScript.mockResolvedValueOnce({ url: 'https://example.org/', selector: '#send', tag: 'button', label: 'Send',
      bounds: { x: 1, y: 2, width: 40, height: 20 }, style: { display: 'block', visibility: 'visible', position: 'static',
        color: 'rgb(0, 0, 0)', backgroundColor: 'transparent', fontSize: '14px', fontFamily: 'sans-serif', zIndex: 'auto' } });
    const inspectId = 'browser-00000000-0000-0000-0000-000000000005';
    await act(async () => { onRequest({ requestId: inspectId, action: 'browser.inspect', parameters: { selector: '#send' } });
      await Promise.resolve(); await Promise.resolve(); });
    expect(face.result).toHaveBeenCalledWith(inspectId, { ok: true,
      data: expect.objectContaining({ selector: '#send', tag: 'button' }) });
    guest.executeJavaScript.mockResolvedValueOnce({ selector: '#send', urlBefore: 'https://example.org/', activated: true, settled: false });
    const clickId = 'browser-00000000-0000-0000-0000-000000000006';
    await act(async () => { onRequest({ requestId: clickId, action: 'browser.click', parameters: {
      selector: '#send', expectedUrl: 'https://example.org/',
    } }); await Promise.resolve(); await Promise.resolve(); });
    expect(face.result).toHaveBeenCalledWith(clickId, { ok: true,
      data: { selector: '#send', urlBefore: 'https://example.org/', activated: true, settled: false } });
    setVisible(false);
    expect(face.unregister).toHaveBeenCalledOnce();
  });
  it('bounds a hung guest inspection and drops a late result after the pane closes', async () => {
    window.__NOTNATIVE_ELECTRON__ = { runtime: 'electron', arch: 'x64', trayEnabled: false };
    let onRequest!: (request: { requestId: string; action: string; parameters: Record<string, unknown> }) => void;
    const face = {
      register: vi.fn().mockResolvedValue({ ok: true }), unregister: vi.fn().mockResolvedValue({ ok: true }),
      claim: vi.fn().mockResolvedValue({ ok: true, result: { granted: true } }),
      result: vi.fn().mockResolvedValue({ ok: true, result: { matched: true } }),
      onRequest: vi.fn((handler: typeof onRequest) => { onRequest = handler; return () => undefined; }),
    };
    window.__NOTNATIVE_BROWSER_CONTROL__ = face;
    readyFetch();
    const view = render();
    enter('https://example.org/');
    await flush();
    const guest = view.querySelector('webview') as HTMLElement & { executeJavaScript?: ReturnType<typeof vi.fn> };
    guest.executeJavaScript = vi.fn(() => new Promise(() => undefined));
    vi.useFakeTimers();
    const timeoutId = 'browser-00000000-0000-0000-0000-000000000003';
    await act(async () => { onRequest({ requestId: timeoutId, action: 'browser.snapshot', parameters: {} });
      await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(face.result).toHaveBeenCalledWith(timeoutId, { ok: false, error: 'Page inspection timed out.' });
    vi.useRealTimers();

    let resolveSnapshot!: (value: unknown) => void;
    guest.executeJavaScript = vi.fn(() => new Promise((resolve) => { resolveSnapshot = resolve; }));
    const lateId = 'browser-00000000-0000-0000-0000-000000000004';
    await act(async () => { onRequest({ requestId: lateId, action: 'browser.snapshot', parameters: {} });
      await Promise.resolve(); });
    setVisible(false);
    await act(async () => { resolveSnapshot({ url: 'https://example.org/', title: 'Late', text: '', textTotalChars: 0,
      textTruncated: false, elements: [], interactiveElementsOnPage: 0, elementsTruncated: false });
      await Promise.resolve(); });
    expect(face.result).not.toHaveBeenCalledWith(lateId, expect.anything());
  });
  it('does not take a fresh snapshot while a timed-out click can still run', async () => {
    window.__NOTNATIVE_ELECTRON__ = { runtime: 'electron', arch: 'x64', trayEnabled: false };
    let onRequest!: (request: { requestId: string; action: string; parameters: Record<string, unknown> }) => void;
    const face = {
      register: vi.fn().mockResolvedValue({ ok: true }), unregister: vi.fn().mockResolvedValue({ ok: true }),
      claim: vi.fn().mockResolvedValue({ ok: true, result: { granted: true } }),
      result: vi.fn().mockResolvedValue({ ok: true, result: { matched: true } }),
      onRequest: vi.fn((handler: typeof onRequest) => { onRequest = handler; return () => undefined; }),
    };
    window.__NOTNATIVE_BROWSER_CONTROL__ = face;
    readyFetch();
    const view = render();
    enter('https://example.org/'); await flush();
    const guest = view.querySelector('webview') as HTMLElement & { executeJavaScript?: ReturnType<typeof vi.fn> };
    let finishClick!: (value: unknown) => void;
    guest.executeJavaScript = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finishClick = resolve; }))
      .mockResolvedValue({ url: 'https://example.org/', title: 'After', text: '', textTotalChars: 0,
        textTruncated: false, elements: [], interactiveElementsOnPage: 0, elementsTruncated: false });
    vi.useFakeTimers();
    const clickId = 'browser-00000000-0000-0000-0000-000000000007';
    await act(async () => { onRequest({ requestId: clickId, action: 'browser.click', parameters: {
      selector: '#send', expectedUrl: 'https://example.org/',
    } }); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(face.result).toHaveBeenCalledWith(clickId, { ok: false,
      error: 'Click result timed out; inspect the page before retrying.' });
    const blocked = 'browser-00000000-0000-0000-0000-000000000008';
    await act(async () => { onRequest({ requestId: blocked, action: 'browser.snapshot', parameters: {} }); await Promise.resolve(); });
    expect(face.result).toHaveBeenCalledWith(blocked, { ok: false,
      error: 'A prior click is still running; wait before taking a new snapshot.' });
    expect(guest.executeJavaScript).toHaveBeenCalledOnce();
    await act(async () => { finishClick({ selector: '#send', urlBefore: 'https://example.org/', activated: true,
      settled: false }); await Promise.resolve(); });
    const fresh = 'browser-00000000-0000-0000-0000-000000000009';
    await act(async () => { onRequest({ requestId: fresh, action: 'browser.snapshot', parameters: {} }); await Promise.resolve(); });
    expect(face.result).toHaveBeenCalledWith(fresh, { ok: true, data: expect.objectContaining({ title: 'After' }) });
  });
  it('uses an isolated guest only for desktop HTTPS or loopback HTTP', async () => {
    expect(canEmbedDesktopPreview('http://localhost:5173/')).toBe(true);
    expect(canEmbedDesktopPreview('https://example.org/')).toBe(true);
    expect(canEmbedDesktopPreview('http://example.org/')).toBe(false);
    window.__NOTNATIVE_ELECTRON__ = { runtime: 'electron', arch: 'x64', trayEnabled: false };
    readyFetch();
    const view = render();
    enter('localhost:5173'); await flush();
    expect(view.querySelector('iframe')).toBeNull();
    expect(view.querySelector('webview')?.getAttribute('src')).toBe('http://localhost:5173/');
    expect(view.querySelector('webview')?.getAttribute('partition')).toBe('nnd-preview');
    enter('http://example.org/');
    expect(view.querySelector('webview')?.getAttribute('src')).toBe('http://localhost:5173/');
    expect(view.textContent).toContain('requires HTTPS or loopback HTTP');
  });
  it('tracks guest navigations without remounting the page or probing again', async () => {
    window.__NOTNATIVE_ELECTRON__ = { runtime: 'electron', arch: 'x64', trayEnabled: false };
    readyFetch();
    const view = render();
    enter('localhost:5173/one'); await flush();
    const guest = view.querySelector('webview')!;
    const probes = vi.mocked(globalThis.fetch).mock.calls.filter(([url]) => url === '/api/system/probe-url').length;
    act(() => guest.dispatchEvent(Object.assign(new Event('did-navigate'), { url: 'http://localhost:5173/two' })));
    expect(view.querySelector('webview')).toBe(guest);
    expect(view.querySelector('input[aria-label="Preview address"]')?.getAttribute('value')).toBe('http://localhost:5173/two');
    expect(vi.mocked(globalThis.fetch).mock.calls.filter(([url]) => url === '/api/system/probe-url')).toHaveLength(probes);
    act(() => (view.querySelector('[aria-label="Preview back"]') as HTMLButtonElement).click());
    await flush();
    expect(view.querySelector('webview')?.getAttribute('src')).toBe('http://localhost:5173/one');
  });
  it('restores the navigated guest URL when the pane is hidden and revealed', async () => {
    window.__NOTNATIVE_ELECTRON__ = { runtime: 'electron', arch: 'x64', trayEnabled: false };
    readyFetch();
    const view = render();
    enter('localhost:5173/one'); await flush();
    const guest = view.querySelector('webview')!;
    act(() => guest.dispatchEvent(Object.assign(new Event('did-navigate'), { url: 'https://example.org/two' })));
    expect(view.querySelector('webview')).toBe(guest);
    setVisible(false);
    expect(view.querySelector('webview')).toBeNull();
    setVisible(true);
    expect(view.querySelector('webview')?.getAttribute('src')).toBe('https://example.org/two');
    expect(view.querySelector('input[aria-label="Preview address"]')?.getAttribute('value')).toBe('https://example.org/two');
  });
  it('reports guest main-frame failures but ignores superseded loads', async () => {
    window.__NOTNATIVE_ELECTRON__ = { runtime: 'electron', arch: 'x64', trayEnabled: false };
    readyFetch();
    const view = render();
    enter('https://example.org/'); await flush();
    const guest = view.querySelector('webview')!;
    act(() => guest.dispatchEvent(Object.assign(new Event('did-fail-load'), {
      errorCode: -3, errorDescription: 'aborted', isMainFrame: true,
    })));
    expect(view.textContent).not.toContain('aborted');
    act(() => guest.dispatchEvent(Object.assign(new Event('did-fail-load'), {
      errorCode: -105, errorDescription: 'NAME_NOT_RESOLVED', isMainFrame: true,
    })));
    expect(view.textContent).toContain('NAME_NOT_RESOLVED');
  });
  it('shows a bounded user-requested page snapshot only in the desktop guest', async () => {
    window.__NOTNATIVE_ELECTRON__ = { runtime: 'electron', arch: 'x64', trayEnabled: false };
    readyFetch();
    const view = render();
    enter('https://example.org/'); await flush();
    const guest = view.querySelector('webview') as HTMLElement & { executeJavaScript?: ReturnType<typeof vi.fn> };
    guest.executeJavaScript = vi.fn().mockResolvedValue({ url: 'https://example.org/', title: 'Example', text: 'Ready',
      textTotalChars: 5, textTruncated: false, elements: [], interactiveElementsOnPage: 0, elementsTruncated: false });
    await act(async () => { [...view.querySelectorAll('button')].find((button) => button.textContent === 'Inspect page')!.click(); await Promise.resolve(); });
    expect(guest.executeJavaScript).toHaveBeenCalledOnce();
    expect(view.querySelector('[data-testid="browser-page-snapshot"]')?.textContent).toContain('Example');
    expect(view.querySelector('[data-testid="browser-page-snapshot"]')?.textContent).toContain('Ready');
  });
  it('discards a stale inspection after navigation away and back to the same URL', async () => {
    window.__NOTNATIVE_ELECTRON__ = { runtime: 'electron', arch: 'x64', trayEnabled: false };
    readyFetch();
    const view = render();
    enter('https://example.org/'); await flush();
    const guest = view.querySelector('webview') as HTMLElement & { executeJavaScript?: ReturnType<typeof vi.fn> };
    let resolveFirst!: (value: unknown) => void;
    guest.executeJavaScript = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue({ url: 'https://example.org/', title: 'Fresh', text: 'New content',
        textTotalChars: 11, textTruncated: false, elements: [], interactiveElementsOnPage: 0, elementsTruncated: false });
    act(() => [...view.querySelectorAll('button')].find((button) => button.textContent === 'Inspect page')!.click());
    expect(view.textContent).toContain('Inspecting…');
    act(() => guest.dispatchEvent(Object.assign(new Event('did-navigate'), { url: 'https://example.net/' })));
    act(() => guest.dispatchEvent(Object.assign(new Event('did-navigate'), { url: 'https://example.org/' })));
    expect(view.textContent).not.toContain('Inspecting…');
    await act(async () => resolveFirst({ url: 'https://example.org/', title: 'Stale', text: 'Old content',
      textTotalChars: 11, textTruncated: false, elements: [], interactiveElementsOnPage: 0, elementsTruncated: false }));
    expect(view.querySelector('[data-testid="browser-page-snapshot"]')).toBeNull();
    await act(async () => { [...view.querySelectorAll('button')].find((button) => button.textContent === 'Inspect page')!.click(); await Promise.resolve(); });
    expect(view.querySelector('[data-testid="browser-page-snapshot"]')?.textContent).toContain('New content');
  });
  it('recovers the inspection control when the guest script never settles', async () => {
    vi.useFakeTimers();
    try {
      window.__NOTNATIVE_ELECTRON__ = { runtime: 'electron', arch: 'x64', trayEnabled: false };
      readyFetch();
      const view = render();
      enter('https://example.org/'); await flush();
      const guest = view.querySelector('webview') as HTMLElement & { executeJavaScript?: ReturnType<typeof vi.fn> };
      guest.executeJavaScript = vi.fn().mockImplementation(() => new Promise(() => undefined));
      act(() => [...view.querySelectorAll('button')].find((button) => button.textContent === 'Inspect page')!.click());
      expect(view.textContent).toContain('Inspecting…');
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(view.textContent).toContain('Page inspection timed out.');
      expect([...view.querySelectorAll('button')].find((button) => button.textContent === 'Inspect page')?.disabled).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it('offers host-local listener URLs only on a loopback app origin', () => {
    expect(canPreviewDiscoveredServers('http://localhost:3902')).toBe(true);
    expect(canPreviewDiscoveredServers('http://[::1]:3902')).toBe(true);
    expect(canPreviewDiscoveredServers('https://nnd.example.test')).toBe(false);
    expect(canPreviewDiscoveredServers('http://192.168.1.5:3902')).toBe(false);
  });
  it('offers only discovered listeners and opens one on explicit click', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => url === '/api/system/probe-url'
      ? { ok: true, json: async () => ({ ok: true, status: 200 }) }
      : { ok: true, json: async () => ({ servers: [
        { port: 5173, command: '', url: 'http://localhost:5173/' },
      ] }) });
    const view = render();
    await act(async () => { await Promise.resolve(); });
    expect(view.querySelector('iframe')).toBeNull();
    expect(view.textContent).toContain('http://localhost:5173/');
    const candidate = [...view.querySelectorAll('button')].find((button) => button.textContent?.includes('localhost:5173'))!;
    act(() => candidate.click());
    await flush();
    expect(view.querySelector('iframe')?.getAttribute('src')).toBe('http://localhost:5173/');
  });

  it('distinguishes discovery failure from an empty list', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false });
    const view = render();
    await act(async () => { await Promise.resolve(); });
    expect(view.textContent).toContain('Discovery unavailable');
    expect(view.textContent).not.toContain('No local dev servers found');
  });

  it('rejects malformed discovery URLs before making them clickable', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ servers: [
      { port: 5173, command: '', url: 'javascript:alert(1)' },
    ] }) });
    const view = render();
    await act(async () => { await Promise.resolve(); });
    expect(view.textContent).toContain('Discovery unavailable');
    expect(view.querySelector('iframe')).toBeNull();
  });

  it('refreshes discovery while visible and empty', async () => {
    vi.useFakeTimers();
    try {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ servers: [] }) })
        .mockResolvedValue({ ok: true, json: async () => ({ servers: [
          { port: 5173, command: '', url: 'http://localhost:5173/' },
        ] }) });
      const view = render();
      await act(async () => { await Promise.resolve(); });
      expect(view.textContent).toContain('No local dev servers found');
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(view.textContent).toContain('http://localhost:5173/');
    } finally { vi.useRealTimers(); }
  });

  it('does not scan while the browser panel is hidden', async () => {
    const fetch = vi.fn();
    globalThis.fetch = fetch;
    render(false);
    await act(async () => { await Promise.resolve(); });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('starts empty and only loads a user-submitted URL in a sandboxed frame', async () => {
    readyFetch();
    const view = render();
    expect(view.querySelector('iframe')).toBeNull();
    enter('localhost:5173');
    await flush();
    const frame = view.querySelector('iframe')!;
    expect(frame.getAttribute('src')).toBe('http://localhost:5173/');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-forms');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(view.querySelector('a')?.getAttribute('href')).toBe('http://localhost:5173/');
  });

  it('supports own back/forward history and reload without navigating to invalid URLs', async () => {
    readyFetch();
    const view = render();
    enter('localhost:5173/one');
    await flush();
    enter('localhost:5173/two');
    await flush();
    expect(view.querySelector('iframe')?.getAttribute('src')).toBe('http://localhost:5173/two');
    act(() => (view.querySelector('[aria-label="Preview back"]') as HTMLButtonElement).click());
    await flush();
    expect(view.querySelector('iframe')?.getAttribute('src')).toBe('http://localhost:5173/one');
    act(() => (view.querySelector('[aria-label="Preview forward"]') as HTMLButtonElement).click());
    await flush();
    expect(view.querySelector('iframe')?.getAttribute('src')).toBe('http://localhost:5173/two');
    const frame = view.querySelector('iframe');
    act(() => (view.querySelector('[aria-label="Reload preview"]') as HTMLButtonElement).click());
    await flush();
    expect(view.querySelector('iframe')).not.toBe(frame);
    enter('javascript:alert(1)');
    expect(view.querySelector('iframe')?.getAttribute('src')).toBe('http://localhost:5173/two');
    expect(view.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('waits for a local server before mounting the iframe, then retries explicitly after probe failure', async () => {
    const probe = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValue({ ok: true,
      json: async () => ({ ok: true, status: 200 }) });
    globalThis.fetch = vi.fn().mockImplementation((url: string) => url === '/api/system/probe-url'
      ? probe() : Promise.resolve({ ok: true, json: async () => ({ servers: [] }) }));
    const view = render();
    enter('localhost:5173');
    expect(view.querySelector('iframe')).toBeNull();
    await flush();
    expect(view.textContent).toContain('Readiness check unavailable');
    act(() => [...view.querySelectorAll('button')].find((button) => button.textContent === 'Retry')!.click());
    await flush();
    expect(view.querySelector('iframe')).not.toBeNull();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('unmounts a hidden preview and checks readiness again when revealed', async () => {
    let resolveSecond!: (response: object) => void;
    const probe = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, status: 200 }) })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
    globalThis.fetch = vi.fn().mockImplementation((url: string) => url === '/api/system/probe-url'
      ? probe() : Promise.resolve({ ok: true, json: async () => ({ servers: [] }) }));
    const view = render();
    enter('localhost:5173');
    await flush();
    expect(view.querySelector('iframe')).not.toBeNull();
    setVisible(false);
    expect(view.querySelector('iframe')).toBeNull();
    setVisible(true);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(view.querySelector('iframe')).toBeNull();
    await act(async () => resolveSecond({ ok: true, json: async () => ({ ok: true, status: 200 }) }));
    expect(view.querySelector('iframe')).not.toBeNull();
  });

  it('keeps a stale history probe from opening the previous URL', async () => {
    let resolveFirst!: (response: object) => void;
    const probe = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue({ ok: true, json: async () => ({ ok: true, status: 200 }) });
    globalThis.fetch = vi.fn().mockImplementation((url: string) => url === '/api/system/probe-url'
      ? probe() : Promise.resolve({ ok: true, json: async () => ({ servers: [] }) }));
    const view = render();
    enter('localhost:5173/one');
    enter('localhost:5173/two');
    await flush();
    expect(view.querySelector('iframe')?.getAttribute('src')).toBe('http://localhost:5173/two');
    await act(async () => resolveFirst({ ok: true, json: async () => ({ ok: true, status: 200 }) }));
    expect(view.querySelector('iframe')?.getAttribute('src')).toBe('http://localhost:5173/two');
  });

  it('waits through a gateway 5xx until it answers successfully', async () => {
    vi.useFakeTimers();
    try {
      const probe = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, status: 503 }) })
        .mockResolvedValue({ ok: true, json: async () => ({ ok: true, status: 200 }) });
      globalThis.fetch = vi.fn().mockImplementation((url: string) => url === '/api/system/probe-url'
        ? probe() : Promise.resolve({ ok: true, json: async () => ({ servers: [] }) }));
      const view = render();
      enter('localhost:5173');
      await flush();
      expect(view.querySelector('iframe')).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(view.querySelector('iframe')).not.toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('ends the gateway startup wait after 20 seconds if 5xx persists', async () => {
    vi.useFakeTimers();
    try {
      const probe = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, status: 503 }) });
      globalThis.fetch = vi.fn().mockImplementation((url: string) => url === '/api/system/probe-url'
        ? probe() : Promise.resolve({ ok: true, json: async () => ({ servers: [] }) }));
      const view = render();
      enter('localhost:5173');
      await act(async () => { await vi.advanceTimersByTimeAsync(19_999); });
      expect(view.querySelector('iframe')).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(view.querySelector('iframe')?.getAttribute('src')).toBe('http://localhost:5173/');
      expect(probe).toHaveBeenCalledTimes(11);
    } finally { vi.useRealTimers(); }
  });

  it('reports malformed successful probe data as unavailable', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => url === '/api/system/probe-url'
      ? Promise.resolve({ ok: true, json: async () => ({ ok: true }) })
      : Promise.resolve({ ok: true, json: async () => ({ servers: [] }) }));
    const view = render();
    enter('localhost:5173');
    await flush();
    expect(view.querySelector('iframe')).toBeNull();
    expect(view.textContent).toContain('Readiness check unavailable');
  });

  it('times out even when a probe request never settles', async () => {
    vi.useFakeTimers();
    try {
      globalThis.fetch = vi.fn().mockImplementation((url: string) => url === '/api/system/probe-url'
        ? new Promise(() => undefined) : Promise.resolve({ ok: true, json: async () => ({ servers: [] }) }));
      const view = render();
      enter('localhost:5173');
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(view.querySelector('iframe')).toBeNull();
      expect(view.textContent).toContain('Local server did not answer within 30 seconds.');
      expect(view.textContent).toContain('Retry');
    } finally { vi.useRealTimers(); }
  });
});
