// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BrowserSurface, canPreviewDiscoveredServers } from '../browser-surface.tsx';

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean | undefined; }
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const originalFetch = globalThis.fetch;
afterEach(() => { act(() => root?.unmount()); container?.remove(); root = null; container = null; globalThis.fetch = originalFetch; });

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
