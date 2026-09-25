import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { createNnaHarnessAdapter, createNnaHarnessAdapterFromEnvironment } from '../nna.ts';

const token = 'a'.repeat(32);
const principal = Buffer.from(JSON.stringify({ subject_id: 'user_a' })).toString('base64url');

describe('NNA harness adapter', () => {
  it('forwards only approved request headers and keeps credentials server-side', async () => {
    const fetch = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ url: String(url) }), { status: 200, headers: { 'set-cookie': 'foreign=value', authorization: 'Bearer reflected', 'x-nna-principal': principal, 'x-nna-revision': '2' } }));
    const adapter = createNnaHarnessAdapter({ endpoint: 'http://127.0.0.1:4100', token, principal, fetch });
    const response = await adapter.handle(new Request('http://nnd.local/api/session?directory=C%3A%2Fwork', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: 'ui-secret', authorization: 'Bearer browser-value', 'x-nnd-directory': 'C:/work' },
      body: JSON.stringify({ title: 'New session' }),
    }));
    expect(response.status).toBe(200);
    const firstCall = fetch.mock.calls[0]!;
    expect(String(firstCall[0])).toBe('http://127.0.0.1:4100/session?directory=C%3A%2Fwork');
    const headers = new Headers(firstCall[1]?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${token}`);
    expect(headers.get('x-nna-principal')).toBe(principal);
    expect(headers.get('cookie')).toBeNull();
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('authorization')).toBeNull();
    expect(response.headers.get('x-nna-principal')).toBeNull();
    expect(response.headers.get('x-nna-revision')).toBe('2');
  });

  it('fails closed for malformed configuration and unavailable harnesses', async () => {
    expect(() => createNnaHarnessAdapterFromEnvironment({ NNA_HARNESS_URL: 'http://127.0.0.1:4100/path', NNA_INTEGRATION_TOKEN: token, NNA_PRINCIPAL: principal })).toThrow(/origin/u);
    expect(() => createNnaHarnessAdapterFromEnvironment({ NNA_HARNESS_URL: 'http://127.0.0.1:4100/?target=elsewhere', NNA_INTEGRATION_TOKEN: token, NNA_PRINCIPAL: principal })).toThrow(/origin/u);
    expect(() => createNnaHarnessAdapterFromEnvironment({ NNA_HARNESS_URL: 'http://127.0.0.1:4100', NNA_INTEGRATION_TOKEN: 'é'.repeat(32), NNA_PRINCIPAL: principal })).toThrow(/credential/u);
    const adapter = createNnaHarnessAdapter({ endpoint: 'http://127.0.0.1:4100', token, principal, fetch: async () => { throw new Error('offline'); } });
    expect((await adapter.handle(new Request('http://nnd.local/api/session'))).status).toBe(502);
  });

  it('cannot turn a path with two leading slashes into a credentialed authority request', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 204 }));
    const adapter = createNnaHarnessAdapter({ endpoint: 'http://127.0.0.1:4100', token, principal, fetch });
    await adapter.handle(new Request('http://nnd.local/api//attacker.example/steal?x=1'));
    const target = new URL(String(fetch.mock.calls[0]![0]));
    expect(target.origin).toBe('http://127.0.0.1:4100');
    expect(target.pathname).toBe('//attacker.example/steal');
    expect(target.search).toBe('?x=1');
  });

  it('reports a bounded upstream timeout without exposing transport details', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      throw new DOMException('operation aborted', 'AbortError');
    });
    const adapter = createNnaHarnessAdapter({ endpoint: 'http://127.0.0.1:4100', token, principal, fetch });
    const response = await adapter.handle(new Request('http://nnd.local/api/session'));
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: { message: 'NNA harness request timed out' } });
  });

  it('propagates client cancellation while waiting for upstream headers', async () => {
    const client = new AbortController();
    let upstreamSignal: AbortSignal | undefined;
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      upstreamSignal = init?.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        upstreamSignal!.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
      });
    });
    const adapter = createNnaHarnessAdapter({ endpoint: 'http://127.0.0.1:4100', token, principal, fetch });
    const pending = adapter.handle(new Request('http://nnd.local/api/global/event', { signal: client.signal }));
    client.abort();
    const response = await pending;
    expect(upstreamSignal?.aborted).toBe(true);
    expect(response.status).toBe(499);
    expect(await response.json()).toEqual({ error: { message: 'NND request was cancelled' } });
  });

  it('keeps the client abort bound to a live upstream event stream', async () => {
    const client = new AbortController();
    let upstreamSignal: AbortSignal | undefined;
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      upstreamSignal = init?.signal ?? undefined;
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: connected\\n\\n')); } }), {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      });
    });
    const adapter = createNnaHarnessAdapter({ endpoint: 'http://127.0.0.1:4100', token, principal, fetch });
    const response = await adapter.handle(new Request('http://nnd.local/api/global/event', { signal: client.signal }));
    expect(response.status).toBe(200);
    expect(await response.body?.getReader().read()).toMatchObject({ done: false });
    client.abort();
    expect(upstreamSignal?.aborted).toBe(true);
  });

  it('closes the upstream SSE subscription when the downstream aborts after headers', async () => {
    let upstreamClosed = false;
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: connected\n\n');
      response.on('close', () => { upstreamClosed = true; });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('unexpected HTTP address');
      const client = new AbortController();
      const adapter = createNnaHarnessAdapter({ endpoint: `http://127.0.0.1:${address.port}`, token, principal });
      const response = await adapter.handle(new Request('http://nnd.local/api/global/event', { signal: client.signal }));
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      client.abort();
      await vi.waitFor(() => expect(upstreamClosed).toBe(true));
      await reader.cancel().catch(() => {});
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('obtains a principal envelope for every forwarded request', async () => {
    const supplier = vi.fn(() => principal);
    const adapter = createNnaHarnessAdapter({ endpoint: 'http://127.0.0.1:4100', token, principal: supplier, fetch: async () => new Response(null, { status: 204 }) });
    await adapter.handle(new Request('http://nnd.local/api/session'));
    await adapter.handle(new Request('http://nnd.local/api/session'));
    expect(supplier).toHaveBeenCalledTimes(2);
  });

  it('fails closed when a fresh principal cannot be supplied', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const adapter = createNnaHarnessAdapter({ endpoint: 'http://127.0.0.1:4100', token, principal: () => { throw new Error('minting detail'); }, fetch });
    const response = await adapter.handle(new Request('http://nnd.local/api/session'));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: { message: 'NNA harness principal is unavailable' } });
    expect(fetch).not.toHaveBeenCalled();
  });
});
