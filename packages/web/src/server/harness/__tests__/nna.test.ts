import { describe, expect, it, vi } from 'vitest';
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
