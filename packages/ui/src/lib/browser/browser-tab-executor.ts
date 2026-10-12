// SPDX-License-Identifier: Apache-2.0
/**
 * Browser-tab browser-control executor (F7 scoped capability): executes
 * broker actions against a same-origin preview-proxy iframe with Electron
 * never launched. Cross-origin or unproxied pages are refused; DOM capture
 * reports itself as dom mode so a raster screenshot is never faked.
 */
export interface PageSnapshot { url: string; title: string; text: string; nodeCount: number }
export interface PageCapture { url: string; mime: 'text/html;mode=dom'; html: string; text: string;
  width: number; height: number; rendered: false }
export interface PageInspection { selector: string; count: number; html: string }

const MAX_TEXT_CHARS = 20_000;
const MAX_HTML_CHARS = 150_000;
const MAX_SELECTOR_CHARS = 500;

export function previewProxyUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) return null;
    const rest = parsed.pathname === '/' ? '' : parsed.pathname.replace(/^\/+/u, '');
    return '/api/preview-proxy/' + parsed.port + (rest ? '/' + rest : '') + parsed.search;
  } catch { return null; }
}

function guestDocument(frame: HTMLIFrameElement | null): Document | null {
  try { return frame?.contentDocument ?? null; } catch { return null; }
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function requireDocument(frame: HTMLIFrameElement | null): Document {
  const doc = guestDocument(frame);
  if (!doc || !doc.documentElement) {
    throw new Error('The preview page is not served through the same-origin preview proxy; '
      + 'browser-only control cannot act on it.');
  }
  return doc;
}

function settled(doc: Document): string {
  return doc.location?.href ?? '';
}

function describeElement(element: Element): PageInspection {
  return { selector: '', count: 1, html: bounded(element.outerHTML, MAX_HTML_CHARS) };
}

export function executeBrowserSnapshot(frame: HTMLIFrameElement | null): PageSnapshot {
  const doc = requireDocument(frame);
  return { url: settled(doc), title: doc.title ?? '',
    text: bounded(doc.body?.innerText ?? '', MAX_TEXT_CHARS),
    nodeCount: doc.getElementsByTagName('*').length };
}

export function executeBrowserInspect(frame: HTMLIFrameElement | null, selector: string): PageInspection {
  if (typeof selector !== 'string' || !selector || selector.length > MAX_SELECTOR_CHARS) {
    throw new Error('A bounded CSS selector is required.');
  }
  const doc = requireDocument(frame);
  const matched = doc.querySelector(selector);
  if (!matched) return { selector, count: 0, html: '' };
  return { ...describeElement(matched), selector };
}

export function executeBrowserClick(frame: HTMLIFrameElement | null, selector: string): { url: string } {
  const doc = requireDocument(frame);
  const element = doc.querySelector(selector);
  if (!(element instanceof HTMLElement)) throw new Error('The click target was not found on the observed page.');
  element.click();
  return { url: settled(doc) };
}

export function executeBrowserType(frame: HTMLIFrameElement | null, selector: string, text: string): { url: string } {
  if (typeof text !== 'string' || text.length > 2000) throw new Error('Bounded text is required.');
  const doc = requireDocument(frame);
  const element = doc.querySelector(selector);
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
    throw new Error('The type target is not a text field on the observed page.');
  }
  const descriptor = (element instanceof HTMLInputElement
    ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype);
  Object.getOwnPropertyDescriptor(descriptor, 'value')?.set?.call(element, text);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return { url: settled(doc) };
}

export function executeBrowserScroll(frame: HTMLIFrameElement | null, direction: string): { url: string } {
  const doc = requireDocument(frame);
  const view = doc.defaultView;
  if (!view) throw new Error('The preview page has no scrollable viewport.');
  if (direction === 'up') view.scrollBy(0, -view.innerHeight * 0.8);
  else if (direction === 'down') view.scrollBy(0, view.innerHeight * 0.8);
  else if (direction === 'top') view.scrollTo(0, 0);
  else if (direction === 'bottom') view.scrollTo(0, view.document.documentElement.scrollHeight);
  else throw new Error('Unknown scroll direction.');
  return { url: settled(doc) };
}

export function executeBrowserHistory(frame: HTMLIFrameElement | null, direction: string): { url: string } {
  const doc = requireDocument(frame);
  if (direction === 'back') doc.defaultView?.history.back();
  else if (direction === 'forward') doc.defaultView?.history.forward();
  else throw new Error('Unknown history direction.');
  return { url: settled(doc) };
}

/** Honest DOM-mode capture: serialized document plus text, never a raster
 * screenshot; NNA consumers must not treat this as an image capture. */
export function executeBrowserCapture(frame: HTMLIFrameElement | null, expectedUrl: string): PageCapture {
  const doc = requireDocument(frame);
  const url = settled(doc);
  if (url !== expectedUrl) throw new Error('The page changed; take a new snapshot before capture.');
  const view = doc.defaultView;
  return { url, mime: 'text/html;mode=dom', html: bounded(doc.documentElement.outerHTML, MAX_HTML_CHARS),
    text: bounded(doc.body?.innerText ?? '', MAX_TEXT_CHARS),
    width: view?.innerWidth ?? 0, height: view?.innerHeight ?? 0, rendered: false };
}

export interface BrowserTabExecutorHandle { close(): void }

type ExecutorDeps = { getFrame: () => HTMLIFrameElement | null;
  onOpen?: (url: string) => void; onStatus?: (status: string) => void };

export function connectBrowserTabExecutor(origin: string, deps: ExecutorDeps): BrowserTabExecutorHandle {
  const socket = new WebSocket(origin.replace(/^http/u, 'ws') + '/api/browser-control/ws');
  let closed = false;
  const request = (payload: unknown): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
  };
  socket.onopen = () => deps.onStatus?.('registered');
  socket.onclose = () => deps.onStatus?.('disconnected');
  socket.onerror = () => deps.onStatus?.('error');
  socket.onmessage = (event) => {
    let message: { type?: unknown; requestId?: unknown; action?: unknown; parameters?: unknown };
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message.type !== 'request' || typeof message.requestId !== 'string'
      || typeof message.action !== 'string') return;
    request({ type: 'claim', requestId: message.requestId });
    const result = runAction(String(message.action), message.parameters, deps.getFrame(), deps);
    request({ type: 'result', requestId: message.requestId, result });
  };
  return {
    close(): void {
      if (closed) return;
      closed = true;
      try { socket.close(); } catch { /* already closing */ }
    },
  };
}

function runAction(action: string, parameters: unknown, frame: HTMLIFrameElement | null,
  deps: ExecutorDeps): { ok: true; data: unknown } | { ok: false; error: string } {
  const input = (parameters ?? {}) as Record<string, unknown>;
  try {
    if (action === 'browser.snapshot') return { ok: true, data: executeBrowserSnapshot(frame) };
    if (action === 'browser.inspect') {
      return { ok: true, data: executeBrowserInspect(frame, String(input.selector ?? '')) };
    }
    if (action === 'browser.click') {
      return { ok: true, data: executeBrowserClick(frame, String(input.selector ?? '')) };
    }
    if (action === 'browser.type') {
      return { ok: true, data: executeBrowserType(frame, String(input.selector ?? ''), String(input.text ?? '')) };
    }
    if (action === 'browser.scroll') {
      return { ok: true, data: executeBrowserScroll(frame, String(input.direction ?? '')) };
    }
    if (action === 'browser.history' || action === 'browser.back' || action === 'browser.forward') {
      return { ok: true, data: executeBrowserHistory(frame, String(input.direction
        ?? (action === 'browser.back' ? 'back' : 'forward'))) };
    }
    if (action === 'browser.capture') {
      return { ok: true, data: executeBrowserCapture(frame, String(input.expectedUrl ?? '')) };
    }
    if (action === 'browser.open') {
      const requested = String(input.url ?? '');
      const proxy = previewProxyUrl(requested);
      if (!proxy) {
        return { ok: false, error: 'Browser-only preview opens only loopback dev-server pages through the '
          + 'same-origin preview proxy.' };
      }
      deps.onOpen?.(requested);
      return { ok: true, data: { url: requested, opened: true, settled: false } };
    }
    return { ok: false, error: 'Unsupported browser action: ' + action };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Browser action failed.' };
  }
}
