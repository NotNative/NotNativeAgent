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

function enter(address: string): void {
  const input = container!.querySelector('input[aria-label="Preview address"]') as HTMLInputElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, address);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => container!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}

describe('BrowserSurface', () => {
  it('offers host-local listener URLs only on a loopback app origin', () => {
    expect(canPreviewDiscoveredServers('http://localhost:3902')).toBe(true);
    expect(canPreviewDiscoveredServers('http://[::1]:3902')).toBe(true);
    expect(canPreviewDiscoveredServers('https://nnd.example.test')).toBe(false);
    expect(canPreviewDiscoveredServers('http://192.168.1.5:3902')).toBe(false);
  });
  it('offers only discovered listeners and opens one on explicit click', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ servers: [
      { port: 5173, command: '', url: 'http://localhost:5173/' },
    ] }) });
    const view = render();
    await act(async () => { await Promise.resolve(); });
    expect(view.querySelector('iframe')).toBeNull();
    expect(view.textContent).toContain('http://localhost:5173/');
    const candidate = [...view.querySelectorAll('button')].find((button) => button.textContent?.includes('localhost:5173'))!;
    act(() => candidate.click());
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

  it('starts empty and only loads a user-submitted URL in a sandboxed frame', () => {
    const view = render();
    expect(view.querySelector('iframe')).toBeNull();
    enter('localhost:5173');
    const frame = view.querySelector('iframe')!;
    expect(frame.getAttribute('src')).toBe('http://localhost:5173/');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-forms');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(view.querySelector('a')?.getAttribute('href')).toBe('http://localhost:5173/');
  });

  it('supports own back/forward history and reload without navigating to invalid URLs', () => {
    const view = render();
    enter('localhost:5173/one');
    enter('localhost:5173/two');
    expect(view.querySelector('iframe')?.getAttribute('src')).toBe('http://localhost:5173/two');
    act(() => (view.querySelector('[aria-label="Preview back"]') as HTMLButtonElement).click());
    expect(view.querySelector('iframe')?.getAttribute('src')).toBe('http://localhost:5173/one');
    act(() => (view.querySelector('[aria-label="Preview forward"]') as HTMLButtonElement).click());
    expect(view.querySelector('iframe')?.getAttribute('src')).toBe('http://localhost:5173/two');
    const frame = view.querySelector('iframe');
    act(() => (view.querySelector('[aria-label="Reload preview"]') as HTMLButtonElement).click());
    expect(view.querySelector('iframe')).not.toBe(frame);
    enter('javascript:alert(1)');
    expect(view.querySelector('iframe')?.getAttribute('src')).toBe('http://localhost:5173/two');
    expect(view.querySelector('[role="alert"]')).not.toBeNull();
  });
});
