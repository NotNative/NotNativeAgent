// SPDX-License-Identifier: Apache-2.0
/** In-process browser-control rendezvous; no HTTP route grants capability. */
import { randomUUID } from 'node:crypto';

export type BrowserAction = 'browser.open' | 'browser.snapshot' | 'browser.click'
  | 'browser.type' | 'browser.scroll' | 'browser.history' | 'browser.back' | 'browser.forward'
  | 'browser.inspect' | 'browser.resize' | 'browser.capture';

export interface BrowserRequest {
  requestId: string;
  action: BrowserAction;
  parameters: Record<string, unknown>;
}

export type BrowserResult = { ok: true; data: unknown } | { ok: false; error: string };
type Client = { capable: boolean; send: (request: BrowserRequest) => void };
type Pending = { owner: string | null; timer: ReturnType<typeof setTimeout>;
  abort: (() => void) | null; resolve: (result: BrowserResult) => void;
  reject: (error: BrowserControlError) => void; action: BrowserAction;
  sentTo: Set<string>; dispatching: boolean };

export class BrowserControlError extends Error {
  constructor(message: string, readonly status: 499 | 503 | 504) { super(message); }
}

export class BrowserControlBroker {
  private readonly clients = new Map<string, Client>();
  private readonly pending = new Map<string, Pending>();
  private disposed = false;

  registerClient(id: string, capable: boolean, send: Client['send']): () => void {
    if (this.disposed || !id) throw new Error('browser broker unavailable');
    if (this.clients.has(id)) throw new Error('browser client id already registered');
    const client = { capable, send };
    this.clients.set(id, client);
    return () => this.removeClient(id, client);
  }

  request(action: BrowserAction, parameters: Record<string, unknown>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<BrowserResult> {
    if (this.disposed) return Promise.reject(new BrowserControlError('Browser control is unavailable.', 503));
    if (options.signal?.aborted) return Promise.reject(new BrowserControlError('Browser request was cancelled.', 499));
    const timeoutMs = options.timeoutMs ?? (action === 'browser.open' ? 45_000 : 20_000);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000)
      return Promise.reject(new RangeError('browser timeout must be 1000..120000 ms'));
    const requestId = `browser-${randomUUID()}`;
    return new Promise<BrowserResult>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(requestId,
        new BrowserControlError(`The desktop browser did not respond within ${Math.ceil(timeoutMs / 1000)}s.`, 504)), timeoutMs);
      const abort = options.signal ? () => this.fail(requestId,
        new BrowserControlError(entry.owner === null
          ? 'Browser request was cancelled before a desktop accepted it.'
          : 'Browser request was cancelled; the desktop action may still complete.', 499)) : null;
      const entry: Pending = { owner: null, timer, abort, resolve, reject, action,
        sentTo: new Set(), dispatching: true };
      this.pending.set(requestId, entry);
      if (abort) {
        this.abortSignals.set(requestId, options.signal!);
        options.signal!.addEventListener('abort', abort, { once: true });
      }
      const request = { requestId, action, parameters };
      for (const [id, client] of this.clients) {
        if (!this.pending.has(requestId) || entry.owner !== null) break;
        if (action !== 'browser.open' && !client.capable) continue;
        entry.sentTo.add(id);
        try { client.send(request); }
        catch { this.removeClient(id, client); }
      }
      entry.dispatching = false;
      if (entry.sentTo.size === 0) this.fail(requestId,
        new BrowserControlError('No capable desktop browser is connected; nothing was changed.', 503));
    });
  }

  claim(requestId: string, clientId: string): boolean {
    const entry = this.pending.get(requestId);
    const client = this.clients.get(clientId);
    if (!entry || !client || !entry.sentTo.has(clientId) || entry.owner !== null
      || (entry.action !== 'browser.open' && !client.capable)) return false;
    entry.owner = clientId;
    return true;
  }

  resolve(requestId: string, clientId: string, result: BrowserResult): boolean {
    const entry = this.pending.get(requestId);
    if (!entry || entry.owner !== clientId || !this.clients.has(clientId)) return false;
    this.settle(requestId);
    entry.resolve(result);
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clients.clear();
    for (const [requestId, entry] of this.pending)
      this.fail(requestId, new BrowserControlError(entry.owner === null
        ? 'Browser control is unavailable; nothing was changed.'
        : 'Browser control stopped before the desktop reported a result; the action may have changed the page.', 503));
  }

  private removeClient(id: string, client: Client): void {
    if (this.clients.get(id) !== client) return;
    this.clients.delete(id);
    for (const [requestId, entry] of this.pending) {
      entry.sentTo.delete(id);
      if (entry.owner === id) this.fail(requestId,
        new BrowserControlError('The desktop browser disconnected before reporting the result; the action may have changed the page.', 503));
      else if (!entry.dispatching && entry.sentTo.size === 0) this.fail(requestId,
        new BrowserControlError('The desktop browser disconnected before accepting the request; nothing was changed.', 503));
    }
  }

  private settle(requestId: string): Pending | null {
    const entry = this.pending.get(requestId);
    if (!entry) return null;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    if (entry.abort) {
      // AbortSignal is retained only for the request lifetime below.
      this.abortSignals.get(requestId)?.removeEventListener('abort', entry.abort);
      this.abortSignals.delete(requestId);
    }
    return entry;
  }

  private readonly abortSignals = new Map<string, AbortSignal>();

  private fail(requestId: string, error: BrowserControlError): void {
    this.settle(requestId)?.reject(error);
  }
}
