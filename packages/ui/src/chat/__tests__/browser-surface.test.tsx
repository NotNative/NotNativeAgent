// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BrowserSurface, canEmbedDesktopPreview, canPreviewDiscoveredServers } from '../browser-surface.tsx';
import { captureAnnotationImage } from '../../lib/browser/annotation-capture.ts';

vi.mock('../../lib/browser/annotation-capture.ts', () => ({
  captureAnnotationImage: vi.fn().mockResolvedValue({ name: 'browser-annotation-1.jpg', mime: 'image/jpeg',
    dataUrl: 'data:image/jpeg;base64,AA==' }),
}));

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean | undefined; }
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const originalFetch = globalThis.fetch;
afterEach(() => { act(() => root?.unmount()); container?.remove(); root = null; container = null;
  globalThis.fetch = originalFetch; delete window.__NOTNATIVE_ELECTRON__; delete window.__NOTNATIVE_BROWSER_CONTROL__;
  vi.useRealTimers(); vi.mocked(captureAnnotationImage).mockClear(); });

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

const observedPage = { url: 'https://example.org/', title: 'After', text: '', textTotalChars: 0,
  textTruncated: false, elements: [], interactiveElementsOnPage: 0, elementsTruncated: false };

async function brokerSnapshot(onRequest: (request: { requestId: string; action: string; parameters: Record<string, unknown> }) => void,
  result: ReturnType<typeof vi.fn>, requestId: string): Promise<{ observationRevision: number; observationId: string }> {
  await act(async () => { onRequest({ requestId, action: 'browser.snapshot', parameters: {} });
    await Promise.resolve(); await Promise.resolve(); });
  const reply = result.mock.calls.find(([id]) => id === requestId)?.[1] as {
    ok: boolean; data?: { observationRevision?: number; observationId?: string } } | undefined;
  expect(reply?.ok).toBe(true);
  expect(Number.isSafeInteger(reply?.data?.observationRevision)).toBe(true);
  expect(reply?.data?.observationId).toMatch(/^[0-9a-f-]{36}$/u);
  return { observationRevision: reply!.data!.observationRevision!, observationId: reply!.data!.observationId! };
}

describe('BrowserSurface', () => {
  it('draws a region on the host shield and adds only the confirmed image/text pair to the draft', async () => {
    window.__NOTNATIVE_ELECTRON__ = { runtime: 'electron', arch: 'x64', trayEnabled: false };
    readyFetch();
    const view = render(); enter('https://example.org/');
    const guest = view.querySelector('webview') as HTMLElement & {
      executeJavaScript?: ReturnType<typeof vi.fn>; getURL?: () => string };
    guest.getURL = () => 'https://example.org/';
    guest.executeJavaScript = vi.fn().mockResolvedValue({ kind: 'region', url: 'https://example.org/',
      bounds: { x: 20, y: 30, width: 50, height: 40 },
      viewport: { width: 100, height: 100, scrollX: 0, scrollY: 0 } });
    act(() => guest.dispatchEvent(new Event('did-start-loading')));
    const fill = vi.fn((event: Event) => (event as CustomEvent<{ accept: () => void }>).detail.accept());
    const target = (event: Event): void => (event as CustomEvent<{ accept: (key: string) => void }>).detail.accept('test-draft');
    window.addEventListener('nnd:composer-annotation-target', target);
    window.addEventListener('nnd:composer-annotation', fill);
    await flush();
    act(() => ([...view.querySelectorAll('button')].find((button) => button.textContent === 'Annotate region') as HTMLButtonElement).click());
    const shield = view.querySelector('[data-testid="browser-annotation-shield"]') as HTMLDivElement;
    shield.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 } as DOMRect);
    Object.defineProperty(shield, 'clientWidth', { value: 100 });
    Object.defineProperty(shield, 'clientHeight', { value: 100 });
    const dispatch = (type: string, x: number, y: number): void => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { pointerId: 1, button: 0, clientX: x, clientY: y });
      shield.dispatchEvent(event);
    };
    const guestPointer = vi.fn(); guest.addEventListener('pointerup', guestPointer);
    act(() => { dispatch('pointerdown', 20, 30); dispatch('pointermove', 70, 70); });
    expect(view.querySelector('[data-testid="browser-annotation-region"]')).not.toBeNull();
    act(() => window.dispatchEvent(new Event('blur')));
    expect(view.querySelector('[data-testid="browser-annotation-region"]')).toBeNull();
    act(() => { dispatch('pointerdown', 20, 30); dispatch('pointermove', 70, 70); });
    shield.getBoundingClientRect = () => ({ left: 5, top: 0, width: 100, height: 100 } as DOMRect);
    await act(async () => { dispatch('pointerup', 70, 70); await Promise.resolve(); });
    expect(guest.executeJavaScript).not.toHaveBeenCalled();
    expect(view.textContent).toContain('viewport moved');
    shield.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 } as DOMRect);
    act(() => { dispatch('pointerdown', 20, 30); dispatch('pointermove', 70, 70); });
    await act(async () => { dispatch('pointerup', 70, 70); await Promise.resolve(); });
    expect(guestPointer).not.toHaveBeenCalled();
    expect(guest.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('selectPageRegion'), false);
    expect(view.textContent).toContain('Selected page region');
    const comment = view.querySelector('#browser-annotation-comment') as HTMLTextAreaElement;
    act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(comment, 'Fix this area');
      comment.dispatchEvent(new Event('input', { bubbles: true })); });
    vi.mocked(captureAnnotationImage).mockRejectedValueOnce(new Error('The page changed during screenshot capture.'));
    await act(async () => { ([...view.querySelectorAll('button')].find((button) => button.textContent === 'Add to chat draft') as HTMLButtonElement).click();
      await Promise.resolve(); });
    expect(fill).not.toHaveBeenCalled();
    expect((view.querySelector('#browser-annotation-comment') as HTMLTextAreaElement).value).toBe('Fix this area');
    await act(async () => { ([...view.querySelectorAll('button')].find((button) => button.textContent === 'Add to chat draft') as HTMLButtonElement).click();
      await Promise.resolve(); });
    expect(fill).toHaveBeenCalledOnce();
    expect(fill.mock.calls[0]?.[0]).toMatchObject({ detail: { text: expect.stringContaining('user-drawn region'),
      attachment: { mime: 'image/jpeg' } } });
    window.removeEventListener('nnd:composer-annotation', fill);
    window.removeEventListener('nnd:composer-annotation-target', target);
  });

  it('adds a validated user-selected element to the composer draft without sending', async () => {
    window.__NOTNATIVE_ELECTRON__ = { runtime: 'electron', arch: 'x64', trayEnabled: false };
    readyFetch();
    const view = render();
    enter('https://example.org/');
    const guest = view.querySelector('webview') as HTMLElement & {
      executeJavaScript?: ReturnType<typeof vi.fn>; getURL?: () => string };
    guest.getURL = () => 'https://example.org/';
    let resolveSelection!: (value: unknown) => void;
    guest.executeJavaScript = vi.fn().mockImplementation(() => new Promise((resolve) => { resolveSelection = resolve; }));
    act(() => guest.dispatchEvent(new Event('did-start-loading')));
    const fill = vi.fn((event: Event) => (event as CustomEvent<{ accept: () => void }>).detail.accept());
    const target = (event: Event): void => (event as CustomEvent<{ accept: (key: string) => void }>).detail.accept('test-draft');
    window.addEventListener('nnd:composer-annotation-target', target);
    window.addEventListener('nnd:composer-annotation', fill);
    await flush();
    expect((view.querySelector('[data-testid="browser-annotation-controls"] button') as HTMLButtonElement).disabled,
      view.innerHTML.slice(0, 3000)).toBe(false);
    await act(async () => { (view.querySelector('[data-testid="browser-annotation-controls"] button') as HTMLButtonElement).click(); });
    const shield = view.querySelector('[data-testid="browser-annotation-shield"]') as HTMLDivElement;
    expect(shield).not.toBeNull();
    expect(guest.executeJavaScript).not.toHaveBeenCalled();
    expect(view.textContent).toContain('Click a visible page element');
    const pageClick = vi.fn();
    guest.addEventListener('click', pageClick, true);
    shield.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 } as DOMRect);
    await act(async () => { shield.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 })); });
    expect(pageClick).not.toHaveBeenCalled();
    expect(guest.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('selectPageElement'), false);
    await act(async () => { resolveSelection({ url: 'https://example.org/', tag: 'button', selector: 'html > body > button',
      label: 'Save', bounds: { x: 10, y: 20, width: 30, height: 40 },
      viewport: { width: 100, height: 100, scrollX: 0, scrollY: 0 } }); await Promise.resolve(); });
    const comment = view.querySelector('#browser-annotation-comment') as HTMLTextAreaElement;
    act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(comment, 'Please check this.');
      comment.dispatchEvent(new Event('input', { bubbles: true })); });
    vi.mocked(captureAnnotationImage).mockRejectedValueOnce(new Error('The page changed during screenshot capture.'));
    await act(async () => { ([...view.querySelectorAll('button')].find((button) => button.textContent === 'Add to chat draft') as HTMLButtonElement).click();
      await Promise.resolve(); });
    expect(fill).not.toHaveBeenCalled();
    expect((view.querySelector('#browser-annotation-comment') as HTMLTextAreaElement).value).toBe('Please check this.');
    expect(view.querySelector('[data-testid="browser-annotation-draft"]')).not.toBeNull();
    await act(async () => { ([...view.querySelectorAll('button')].find((button) => button.textContent === 'Add to chat draft') as HTMLButtonElement).click();
      await Promise.resolve(); });
    expect(fill).toHaveBeenCalledOnce();
    expect(captureAnnotationImage).toHaveBeenCalledTimes(2);
    expect(fill.mock.calls[0]?.[0]).toMatchObject({ detail: { attachment: { mime: 'image/jpeg' },
      text: expect.stringContaining('User comment: Please check this.') } });
    window.removeEventListener('nnd:composer-annotation', fill);
    window.removeEventListener('nnd:composer-annotation-target', target);
  });

  it('tears down the host shield on Escape or same-URL guest remount and drops late selection', async () => {
    window.__NOTNATIVE_ELECTRON__ = { runtime: 'electron', arch: 'x64', trayEnabled: false };
    readyFetch();
    const view = render();
    enter('https://example.org/');
    const guest = view.querySelector('webview') as HTMLElement & {
      executeJavaScript?: ReturnType<typeof vi.fn>; getURL?: () => string };
    guest.getURL = () => 'https://example.org/';
    let resolveSelection!: (value: unknown) => void;
    guest.executeJavaScript = vi.fn().mockImplementation(() => new Promise((resolve) => { resolveSelection = resolve; }));
    act(() => guest.dispatchEvent(new Event('did-start-loading')));
    const toggle = (): void => { (view.querySelector('[data-testid="browser-annotation-controls"] button') as HTMLButtonElement).click(); };
    act(toggle);
    expect(view.querySelector('[data-testid="browser-annotation-shield"]')).not.toBeNull();
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })));
    expect(view.querySelector('[data-testid="browser-annotation-shield"]')).not.toBeNull();
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(view.querySelector('[data-testid="browser-annotation-shield"]')).toBeNull();
    act(toggle);
    const shield = view.querySelector('[data-testid="browser-annotation-shield"]') as HTMLDivElement;
    shield.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 } as DOMRect);
    await act(async () => { shield.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 })); });
    act(() => (view.querySelector('[aria-label="Reload preview"]') as HTMLButtonElement).click());
    expect(view.querySelector('[data-testid="browser-annotation-shield"]')).toBeNull();
    await act(async () => { resolveSelection({ url: 'https://example.org/', tag: 'button', selector: 'button', label: 'Late',
      bounds: { x: 1, y: 1, width: 20, height: 20 },
      viewport: { width: 100, height: 100, scrollX: 0, scrollY: 0 } }); await Promise.resolve(); });
    expect(view.querySelector('[data-testid="browser-annotation-draft"]')).toBeNull();
  });

  it('refuses to append a selected element after same-URL navigation invalidates it', async () => {
    window.__NOTNATIVE_ELECTRON__ = { runtime: 'electron', arch: 'x64', trayEnabled: false };
    readyFetch();
    const view = render();
    enter('https://example.org/');
    const guest = view.querySelector('webview') as HTMLElement & {
      executeJavaScript?: ReturnType<typeof vi.fn>; getURL?: () => string };
    guest.getURL = () => 'https://example.org/';
    guest.executeJavaScript = vi.fn().mockResolvedValue({ url: 'https://example.org/', tag: 'button',
      selector: 'html > body > button', label: 'Save', bounds: { x: 1, y: 2, width: 30, height: 20 },
      viewport: { width: 100, height: 100, scrollX: 0, scrollY: 0 } });
    act(() => guest.dispatchEvent(new Event('did-start-loading')));
    act(() => (view.querySelector('[data-testid="browser-annotation-controls"] button') as HTMLButtonElement).click());
    const shield = view.querySelector('[data-testid="browser-annotation-shield"]') as HTMLDivElement;
    shield.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 } as DOMRect);
    await act(async () => { shield.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }));
      await Promise.resolve(); });
    const comment = view.querySelector('#browser-annotation-comment') as HTMLTextAreaElement;
    act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(comment, 'Change this');
      comment.dispatchEvent(new Event('input', { bubbles: true })); });
    act(() => guest.dispatchEvent(new Event('did-start-loading')));
    const fill = vi.fn();
    window.addEventListener('nnd:composer-fill', fill);
    act(() => ([...view.querySelectorAll('button')].find((button) => button.textContent === 'Add to chat draft') as HTMLButtonElement).click());
    expect(fill).not.toHaveBeenCalled();
    expect(view.textContent).toContain('The page changed');
    window.removeEventListener('nnd:composer-fill', fill);
  });

  it('navigates only observed preview history and blocks snapshots until the replacement guest finishes loading', async () => {
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
    enter('https://example.org/first');
    enter('https://example.org/second');
    const source = view.querySelector('webview') as HTMLElement & { executeJavaScript?: ReturnType<typeof vi.fn>; getURL?: () => string };
    source.executeJavaScript = vi.fn().mockResolvedValue({ ...observedPage, url: 'https://example.org/second' });
    source.getURL = () => 'https://example.org/second';
    const evidence = await brokerSnapshot(onRequest, face.result, 'browser-00000000-0000-0000-0000-000000000041');
    const historyId = 'browser-00000000-0000-0000-0000-000000000042';
    await act(async () => { onRequest({ requestId: historyId, action: 'browser.history', parameters: {
      direction: 'back', expectedUrl: 'https://example.org/second', ...evidence,
    } }); await Promise.resolve(); await Promise.resolve(); });
    expect(face.result).toHaveBeenCalledWith(historyId, { ok: true, data: {
      direction: 'back', urlBefore: 'https://example.org/second', targetUrl: 'https://example.org/first',
      requested: true, settled: false,
    } });
    const replacement = view.querySelector('webview') as HTMLElement & {
      executeJavaScript?: ReturnType<typeof vi.fn>; getURL?: () => string; isLoading?: () => boolean };
    expect(replacement).not.toBe(source);
    expect(replacement.getAttribute('src')).toBe('https://example.org/first');
    replacement.executeJavaScript = vi.fn().mockResolvedValue({ ...observedPage, url: 'https://example.org/first' });
    let loading = true;
    replacement.getURL = () => 'https://example.org/first';
    replacement.isLoading = () => loading;
    const earlyId = 'browser-00000000-0000-0000-0000-000000000043';
    await act(async () => { onRequest({ requestId: earlyId, action: 'browser.snapshot', parameters: {} });
      await Promise.resolve(); await Promise.resolve(); });
    expect(face.result.mock.calls.find(([id]) => id === earlyId)?.[1]).toEqual({ ok: false,
      error: 'A prior browser action is still running; wait before taking a new snapshot.' });
    loading = false;
    act(() => replacement.dispatchEvent(new Event('did-stop-loading')));
    const firstEvidence = await brokerSnapshot(onRequest, face.result, 'browser-00000000-0000-0000-0000-000000000044');
    const missingId = 'browser-00000000-0000-0000-0000-000000000045';
    await act(async () => { onRequest({ requestId: missingId, action: 'browser.history', parameters: {
      direction: 'back', expectedUrl: 'https://example.org/first', ...firstEvidence,
    } }); await Promise.resolve(); await Promise.resolve(); });
    expect(face.result.mock.calls.find(([id]) => id === missingId)?.[1]).toEqual({ ok: false,
      error: 'No back page is available in this preview history.' });
  });

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
    const clickObservation = (face.result.mock.calls.find(([id]) => id === snapshotId)?.[1] as {
      data: { observationRevision: number; observationId: string } }).data;
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
      selector: '#send', expectedUrl: 'https://example.org/', ...clickObservation,
    } }); await Promise.resolve(); await Promise.resolve(); });
    expect(face.result).toHaveBeenCalledWith(clickId, { ok: true,
      data: { selector: '#send', urlBefore: 'https://example.org/', activated: true, settled: false } });
    const scrollObservation = await brokerSnapshot(onRequest, face.result, 'browser-00000000-0000-0000-0000-000000000020');
    guest.executeJavaScript.mockResolvedValueOnce({ urlBefore: 'https://example.org/', direction: 'down',
      scrollY: 400, maxScrollY: 1000, atTop: false, atBottom: false, settled: true });
    const scrollId = 'browser-00000000-0000-0000-0000-000000000007';
    await act(async () => { onRequest({ requestId: scrollId, action: 'browser.scroll', parameters: {
      direction: 'down', expectedUrl: 'https://example.org/', ...scrollObservation,
    } }); await Promise.resolve(); await Promise.resolve(); });
    expect(face.result).toHaveBeenCalledWith(scrollId, { ok: true,
      data: expect.objectContaining({ direction: 'down', scrollY: 400, settled: true }) });
    const typeObservation = await brokerSnapshot(onRequest, face.result, 'browser-00000000-0000-0000-0000-000000000021');
    guest.executeJavaScript.mockResolvedValueOnce({ selector: '#query', urlBefore: 'https://example.org/', typed: true, settled: false });
    const typeId = 'browser-00000000-0000-0000-0000-000000000015';
    await act(async () => { onRequest({ requestId: typeId, action: 'browser.type', parameters: {
      selector: '#query', expectedUrl: 'https://example.org/', text: 'hello', ...typeObservation,
    } }); await Promise.resolve(); await Promise.resolve(); });
    expect(face.result).toHaveBeenCalledWith(typeId, { ok: true,
      data: { selector: '#query', urlBefore: 'https://example.org/', typed: true, settled: false } });
    const captureObservation = await brokerSnapshot(onRequest, face.result, 'browser-00000000-0000-0000-0000-000000000031');
    Object.defineProperty(guest, 'getBoundingClientRect', { configurable: true,
      value: () => ({ width: 800, height: 600 }) });
    const capturePage = vi.fn().mockResolvedValue({ getSize: () => ({ width: 800, height: 600 }),
      toJPEG: () => Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]) });
    Object.assign(guest, { capturePage });
    const captureId = 'browser-00000000-0000-0000-0000-000000000032';
    await act(async () => { onRequest({ requestId: captureId, action: 'browser.capture', parameters: {
      expectedUrl: 'https://example.org/', ...captureObservation,
    } }); await Promise.resolve(); await Promise.resolve(); });
    expect(capturePage).toHaveBeenCalledOnce();
    expect(face.result).toHaveBeenCalledWith(captureId, { ok: true,
      data: { url: 'https://example.org/', mime: 'image/jpeg', base64: '/9j/2Q==', width: 800, height: 600 } });
    const failedTypeObservation = await brokerSnapshot(onRequest, face.result, 'browser-00000000-0000-0000-0000-000000000022');
    guest.executeJavaScript.mockResolvedValueOnce({ error: 'Type result timed out: page echoed hello' });
    const failedTypeId = 'browser-00000000-0000-0000-0000-000000000019';
    await act(async () => { onRequest({ requestId: failedTypeId, action: 'browser.type', parameters: {
      selector: '#query', expectedUrl: 'https://example.org/', text: 'hello', ...failedTypeObservation,
    } }); await Promise.resolve(); await Promise.resolve(); });
    expect(face.result).toHaveBeenCalledWith(failedTypeId, { ok: false,
      error: 'Type action failed or its outcome is uncertain; inspect the page before retrying.' });
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
    guest.executeJavaScript = vi.fn().mockResolvedValueOnce(observedPage)
      .mockImplementationOnce(() => new Promise((resolve) => { finishClick = resolve; }))
      .mockResolvedValue(observedPage);
    const clickObservation = await brokerSnapshot(onRequest, face.result, 'browser-00000000-0000-0000-0000-000000000023');
    vi.useFakeTimers();
    const clickId = 'browser-00000000-0000-0000-0000-000000000007';
    await act(async () => { onRequest({ requestId: clickId, action: 'browser.click', parameters: {
      selector: '#send', expectedUrl: 'https://example.org/', ...clickObservation,
    } }); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(face.result).toHaveBeenCalledWith(clickId, { ok: false,
      error: 'Click result timed out; inspect the page before retrying.' });
    const blocked = 'browser-00000000-0000-0000-0000-000000000008';
    await act(async () => { onRequest({ requestId: blocked, action: 'browser.snapshot', parameters: {} }); await Promise.resolve(); });
    expect(face.result).toHaveBeenCalledWith(blocked, { ok: false,
      error: 'A prior browser action is still running; wait before taking a new snapshot.' });
    expect(guest.executeJavaScript).toHaveBeenCalledTimes(2);
    await act(async () => { finishClick({ selector: '#send', urlBefore: 'https://example.org/', activated: true,
      settled: false }); await Promise.resolve(); });
    const fresh = 'browser-00000000-0000-0000-0000-000000000009';
    await act(async () => { onRequest({ requestId: fresh, action: 'browser.snapshot', parameters: {} }); await Promise.resolve(); });
    expect(face.result).toHaveBeenCalledWith(fresh, { ok: true, data: expect.objectContaining({ title: 'After' }) });
  });
  it('blocks observations and repeated writes until a timed-out scroll settles', async () => {
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
    let finishScroll!: (value: unknown) => void;
    guest.executeJavaScript = vi.fn().mockResolvedValueOnce(observedPage)
      .mockImplementationOnce(() => new Promise((resolve) => { finishScroll = resolve; }))
      .mockResolvedValue(observedPage);
    const scrollObservation = await brokerSnapshot(onRequest, face.result, 'browser-00000000-0000-0000-0000-000000000024');
    vi.useFakeTimers();
    const scrollId = 'browser-00000000-0000-0000-0000-000000000010';
    await act(async () => { onRequest({ requestId: scrollId, action: 'browser.scroll', parameters: {
      direction: 'down', expectedUrl: 'https://example.org/', ...scrollObservation,
    } }); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(face.result).toHaveBeenCalledWith(scrollId, { ok: false,
      error: 'Scroll result timed out; inspect the page before retrying.' });
    const snapshotId = 'browser-00000000-0000-0000-0000-000000000011';
    await act(async () => { onRequest({ requestId: snapshotId, action: 'browser.snapshot', parameters: {} }); await Promise.resolve(); });
    expect(face.result).toHaveBeenCalledWith(snapshotId, { ok: false,
      error: 'A prior browser action is still running; wait before taking a new snapshot.' });
    const repeatId = 'browser-00000000-0000-0000-0000-000000000012';
    await act(async () => { onRequest({ requestId: repeatId, action: 'browser.scroll', parameters: {
      direction: 'down', expectedUrl: 'https://example.org/', ...scrollObservation,
    } }); await Promise.resolve(); });
    expect(face.result).toHaveBeenCalledWith(repeatId, { ok: false,
      error: 'The page changed; take a new snapshot before scrolling.' });
    expect(guest.executeJavaScript).toHaveBeenCalledTimes(2);
    await act(async () => { finishScroll({ urlBefore: 'https://example.org/', direction: 'down',
      scrollY: 400, maxScrollY: 1000, atTop: false, atBottom: false, settled: true }); await Promise.resolve(); });
    vi.useRealTimers();
    const freshId = 'browser-00000000-0000-0000-0000-000000000013';
    await act(async () => { onRequest({ requestId: freshId, action: 'browser.snapshot', parameters: {} }); await Promise.resolve(); });
    expect(face.result).toHaveBeenCalledWith(freshId, { ok: true, data: expect.objectContaining({ title: 'After' }) });
  });
  it('does not report a settled scroll when the guest starts navigating during execution', async () => {
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
    guest.executeJavaScript = vi.fn().mockResolvedValueOnce(observedPage).mockImplementation(() => {
      guest.dispatchEvent(new Event('did-start-loading'));
      return Promise.resolve({ urlBefore: 'https://example.org/', direction: 'down',
        scrollY: 400, maxScrollY: 1000, atTop: false, atBottom: false, settled: true });
    });
    const scrollObservation = await brokerSnapshot(onRequest, face.result, 'browser-00000000-0000-0000-0000-000000000025');
    const scrollId = 'browser-00000000-0000-0000-0000-000000000014';
    await act(async () => { onRequest({ requestId: scrollId, action: 'browser.scroll', parameters: {
      direction: 'down', expectedUrl: 'https://example.org/', ...scrollObservation,
    } }); await Promise.resolve(); await Promise.resolve(); });
    expect(face.result).toHaveBeenCalledWith(scrollId, { ok: false,
      error: 'Scroll outcome is uncertain; inspect the page before retrying.' });
  });
  it('blocks new observations while a timed-out type may still complete', async () => {
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
    const view = render(); enter('https://example.org/'); await flush();
    const guest = view.querySelector('webview') as HTMLElement & { executeJavaScript?: ReturnType<typeof vi.fn> };
    let finishType!: (value: unknown) => void;
    guest.executeJavaScript = vi.fn().mockResolvedValueOnce(observedPage)
      .mockImplementationOnce(() => new Promise((resolve) => { finishType = resolve; }))
      .mockResolvedValue(observedPage);
    const typeObservation = await brokerSnapshot(onRequest, face.result, 'browser-00000000-0000-0000-0000-000000000026');
    vi.useFakeTimers();
    const typeId = 'browser-00000000-0000-0000-0000-000000000016';
    await act(async () => { onRequest({ requestId: typeId, action: 'browser.type', parameters: {
      selector: '#query', expectedUrl: 'https://example.org/', text: 'hello', ...typeObservation,
    } }); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(face.result).toHaveBeenCalledWith(typeId, { ok: false,
      error: 'Type result timed out; inspect the page before retrying.' });
    const snapshotId = 'browser-00000000-0000-0000-0000-000000000017';
    await act(async () => { onRequest({ requestId: snapshotId, action: 'browser.snapshot', parameters: {} }); await Promise.resolve(); });
    expect(face.result).toHaveBeenCalledWith(snapshotId, { ok: false,
      error: 'A prior browser action is still running; wait before taking a new snapshot.' });
    expect(guest.executeJavaScript).toHaveBeenCalledTimes(2);
    await act(async () => { finishType({ selector: '#query', urlBefore: 'https://example.org/', typed: true, settled: false });
      await Promise.resolve(); });
    vi.useRealTimers();
    const freshId = 'browser-00000000-0000-0000-0000-000000000018';
    await act(async () => { onRequest({ requestId: freshId, action: 'browser.snapshot', parameters: {} }); await Promise.resolve(); });
    expect(face.result).toHaveBeenCalledWith(freshId, { ok: true, data: expect.objectContaining({ title: 'After' }) });
  });
  it('rejects click, scroll and type after a same-URL reload invalidates their snapshot revision', async () => {
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
    const view = render(); enter('https://example.org/'); await flush();
    const guest = view.querySelector('webview') as HTMLElement & { executeJavaScript?: ReturnType<typeof vi.fn> };
    guest.executeJavaScript = vi.fn().mockResolvedValue(observedPage);
    const observation = await brokerSnapshot(onRequest, face.result, 'browser-00000000-0000-0000-0000-000000000027');
    act(() => {
      guest.dispatchEvent(new Event('did-start-loading'));
      guest.dispatchEvent(Object.assign(new Event('did-navigate'), { url: 'https://example.org/' }));
    });
    for (const [requestId, action, parameters] of [
      ['browser-00000000-0000-0000-0000-000000000028', 'browser.click', { selector: '#send' }],
      ['browser-00000000-0000-0000-0000-000000000029', 'browser.scroll', { direction: 'down' }],
      ['browser-00000000-0000-0000-0000-000000000030', 'browser.type', { selector: '#query', text: 'hello' }],
    ] as const) {
      await act(async () => { onRequest({ requestId, action, parameters: {
        ...parameters, expectedUrl: 'https://example.org/', ...observation,
      } }); await Promise.resolve(); await Promise.resolve(); });
      expect(face.result).toHaveBeenCalledWith(requestId, expect.objectContaining({ ok: false }));
    }
    expect(guest.executeJavaScript).toHaveBeenCalledOnce();
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
