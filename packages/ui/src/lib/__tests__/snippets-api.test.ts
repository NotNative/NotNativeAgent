// SPDX-License-Identifier: Apache-2.0
/**
 * Transport pin for the snippet client (P9-4e-i): rides the REAL
 * runtimeFetch pipeline (only the native fetch seam is stubbed, captured
 * at module evaluation via vi.hoisted), so 409/400 error bodies must stay
 * readable and the envelope stamping (`ok:true` beside the config-family
 * `success:true`) must be verbatim.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const globalScope = globalThis as { fetch?: typeof fetch };
  const previous = globalScope.fetch;
  const native = vi.fn<(input: RequestInfo, init?: RequestInit) => Promise<Response>>();
  globalScope.fetch = native as unknown as typeof fetch;
  return { native, previous };
});

import { createSnippet, deleteSnippet, expandSnippet, getSnippet, listSnippets, patchSnippet } from '../snippets-api.ts';

const native = hoisted.native;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => { native.mockReset(); });

afterAll(() => {
  (globalThis as { fetch?: unknown }).fetch = hoisted.previous;
});

describe('snippet client over the real runtimeFetch pipeline', () => {
  it('list stamps ok beside the body and create round-trips', async () => {
    native.mockResolvedValueOnce(json(200, { snippets: [{ name: 'sig', text: 'sig-text', scope: 'global' }] }));
    const listed = await listSnippets();
    expect(listed).toEqual({ ok: true, snippets: [{ name: 'sig', text: 'sig-text', scope: 'global' }] });
    native.mockResolvedValueOnce(json(200, { success: true, snippet: { name: 'sig', text: 'v2', scope: 'global' } }));
    const created = await createSnippet('sig', { text: 'v2' });
    expect(created).toEqual({ ok: true, success: true, snippet: { name: 'sig', text: 'v2', scope: 'global' } });
    expect((native.mock.calls[1]![1] as RequestInit).method).toBe('POST');
  });

  it('keeps the server refusal strings verbatim through the real transport', async () => {
    native.mockResolvedValueOnce(json(409, { error: 'snippet exists' }));
    const refused = await createSnippet('sig', { text: 'x' });
    // A pre-consumed error body would fold into the generic message instead.
    expect(refused).toEqual({ ok: false, status: 409, error: 'snippet exists' });
    native.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const opaque = await deleteSnippet('sig');
    expect(opaque).toEqual({ ok: false, status: 500, error: 'snippet request failed (500)' });
    native.mockResolvedValueOnce(json(400, { error: 'snippet name must match [\\w-]{1,64}' }));
    const named = await patchSnippet('bad.name', { text: 'x' });
    expect(named).toEqual({ ok: false, status: 400, error: 'snippet name must match [\\w-]{1,64}' });
  });

  it('expand answers the expanded text stamped ok', async () => {
    native.mockResolvedValueOnce(json(200, { text: 'x sig-text y' }));
    const expanded = await expandSnippet('x #sig y');
    expect(expanded).toEqual({ ok: true, text: 'x sig-text y' });
    const init = native.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ text: 'x #sig y' }));
  });

  it('names are percent-encoded once: odd bytes become honest 400s server-side', async () => {
    native.mockResolvedValueOnce(json(400, { error: 'snippet name must match [\\w-]{1,64}' }));
    await getSnippet('a b');
    expect(native.mock.calls[0]![0]).toBe('/api/config/snippets/a%20b');
    // 'snip%2F' -> 'snip%252F' on the wire -> the server decodes ONCE to
    // 'snip%2F', whose % falls outside the name pattern -> a plain 400.
    native.mockResolvedValueOnce(json(400, { error: 'snippet name must match [\\w-]{1,64}' }));
    const refused = await patchSnippet('snip%2F', { text: 'x' });
    expect(native.mock.calls[1]![0]).toBe('/api/config/snippets/snip%252F');
    expect(refused).toEqual({ ok: false, status: 400, error: 'snippet name must match [\\w-]{1,64}' });
  });
});
