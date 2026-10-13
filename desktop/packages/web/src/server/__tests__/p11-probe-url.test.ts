// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { parseLoopbackProbeUrl, registerProbeUrlRoutes } from '../preview/probe-url.ts';

function request(app: Hono, url: unknown): Promise<Response> {
  return Promise.resolve(app.request('/api/system/probe-url', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }) }));
}

describe('P11 loopback startup probe', () => {
  it('rejects credentials, non-HTTP and non-loopback hosts without contacting them', async () => {
    const fetcher = vi.fn();
    const app = new Hono();
    registerProbeUrlRoutes(app, fetcher);
    for (const target of ['http://127.0.0.1.evil.test/', 'http://192.168.1.2/',
      'http://user:pass@localhost:5173/', 'file:///secret', 'https://example.test/']) {
      const response = await request(app, target);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ ok: false, error: 'Invalid loopback URL' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(parseLoopbackProbeUrl('http://[::1]:5173/')).toBe('http://[::1]:5173/');
  });

  it('uses a bounded GET without following redirects or forwarding credentials', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    const app = new Hono();
    registerProbeUrlRoutes(app, fetcher);
    const response = await request(app, 'http://localhost:5173/ready');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, status: 503 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe('http://localhost:5173/ready');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', redirect: 'manual', credentials: 'omit' });
    expect(fetcher.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
  });

  it('reports connection failure as probe failure rather than 500', async () => {
    const app = new Hono();
    registerProbeUrlRoutes(app, async () => { throw new Error('connection refused'); });
    const response = await request(app, 'http://127.0.0.1:5173/');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'connection refused' });
  });
});
