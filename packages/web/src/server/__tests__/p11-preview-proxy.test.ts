// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createApp } from '../app.ts';
import { registerPreviewProxyRoutes } from '../preview/preview-proxy.ts';

function htmlResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
}

function appWith(allowed: readonly number[], respond: (target: string, init: RequestInit) => Response): Hono {
  const app = new Hono();
  registerPreviewProxyRoutes(app, {
    allowedPorts: async () => allowed,
    fetcher: ((target: string, init: RequestInit) => Promise.resolve(respond(target, init))) as typeof fetch,
  });
  return app;
}

describe('same-origin preview proxy', () => {
  it('proxies only dev-server-discovered loopback ports', async () => {
    const app = appWith([5173], () => htmlResponse('<p>hello</p>'));
    const ok = await app.request('http://nnd.local/api/preview-proxy/5173/index.html');
    expect(ok.status).toBe(200);
    const body = await ok.text();
    expect(body.startsWith('<p>hello</p>')).toBe(true);
    expect(body).toContain('__nndBrowserBridgePerform');
    const refused = await app.request('http://nnd.local/api/preview-proxy/9999/index.html');
    expect(refused.status).toBe(403);
  });

  it('registers ahead of the harness catch-all inside createApp', async () => {
    vi.stubEnv('NOTNATIVE_RUNTIME', 'service');
    vi.stubEnv('NOTNATIVE_HARNESS', 'nna');
    try {
      const app = createApp({ previewProxyPorts: async () => [] });
      const response = await app.request('http://nnd.local/api/preview-proxy/5173/');
      // The harness catch-all answers 502/forwards to NNA (404 'integration
      // endpoint not found') when the preview routes register after it.
      expect(response.status).toBe(403);
      expect(await response.text()).toContain('not an available dev server');
    } finally { vi.unstubAllEnvs(); }
  });

  it('strips operator credentials and hop-by-hop headers, drops framing denials', async () => {
    let seen: unknown = null;
    const app = appWith([5173], (target, init) => {
      seen = init;
      return htmlResponse('<p>hello</p>', { 'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'self'; frame-ancestors 'none'; script-src 'self'" });
    });
    const response = await app.request('http://nnd.local/api/preview-proxy/5173/', {
      headers: { cookie: 'session=secret', authorization: 'Bearer x' },
    });
    expect(response.status).toBe(200);
    const forwarded = seen instanceof Object && 'headers' in seen
      ? (seen as { headers: unknown }).headers : null;
    expect(forwarded instanceof Headers ? forwarded.get('cookie') : null).toBeNull();
    expect(response.headers.get('x-frame-options')).toBeNull();
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain('frame-ancestors \'none\'');
  });

  it('streams non-HTML bodies untouched', async () => {
    const app = appWith([5173], () => new Response('binary-bytes', {
      status: 200, headers: { 'content-type': 'application/octet-stream' } }));
    const response = await app.request('http://nnd.local/api/preview-proxy/5173/assets/app.js');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('binary-bytes');
    expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
  });

  it('reports an unreachable target as 502 without faking content', async () => {
    const app = appWith([5173], () => { throw new Error('connection refused'); });
    const response = await app.request('http://nnd.local/api/preview-proxy/5173/');
    expect(response.status).toBe(502);
  });
});
