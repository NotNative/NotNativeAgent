// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { browserMutationAllowed } from '../lib/http/request-security.ts';
import { createApp, desktopSessionCookieHeader } from '../app.ts';

const TARGET = 'http://127.0.0.1:3902';
function request(path: string, method: string, headers: Record<string, string> = {}): Request {
  return new Request(`${TARGET}${path}`, { method, headers, body: method === 'GET' ? undefined : '{}' });
}

describe('unsafe browser request origin gate', () => {
  it('relaxes only the UI session cookie for the trusted packaged origin', () => {
    const session = 'oc_ui_session=token; Path=/; HttpOnly; SameSite=Strict; Max-Age=60';
    expect(desktopSessionCookieHeader(session)).toBe('oc_ui_session=token; Path=/; HttpOnly; SameSite=None; Max-Age=60; Secure');
    const tunnel = 'nnd_tunnel_session=token; Path=/; SameSite=Lax';
    expect(desktopSessionCookieHeader(tunnel)).toBe(tunnel);
  });

  it('rejects opaque and foreign browser origins, including same-site alternate ports', () => {
    expect(browserMutationAllowed(request('/api/fs/delete', 'POST', { origin: 'null' }))).toBe(false);
    expect(browserMutationAllowed(request('/api/fs/delete', 'POST', { origin: 'null', host: 'null' }))).toBe(false);
    expect(browserMutationAllowed(request('/api/fs/delete', 'POST', { origin: 'https://evil.example' }))).toBe(false);
    expect(browserMutationAllowed(request('/api/fs/delete', 'POST', { origin: 'http://localhost:5173', 'sec-fetch-site': 'same-site' }))).toBe(false);
    expect(browserMutationAllowed(request('/api/fs/delete', 'POST', { 'sec-fetch-site': 'cross-site' }))).toBe(false);
    expect(browserMutationAllowed(request('/api/fs/delete', 'POST', { origin: 'http://localhost' }))).toBe(false); // packaged-client WS exception is not an HTTP write exception
  });

  it('preserves same-origin, reverse-proxy, and non-browser writes', () => {
    expect(browserMutationAllowed(request('/api/fs/delete', 'POST', { origin: TARGET, 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(browserMutationAllowed(request('/api/fs/delete', 'POST', { origin: 'https://nnd.example', host: '127.0.0.1:3902', 'x-forwarded-host': 'nnd.example' }))).toBe(true);
    expect(browserMutationAllowed(request('/api/fs/delete', 'POST'))).toBe(true);
    expect(browserMutationAllowed(request('/api/fs/delete', 'POST', { origin: 'null', authorization: 'Bearer cli-token' }))).toBe(false);
    expect(browserMutationAllowed(request('/api/fs/delete', 'POST', { origin: 'null', authorization: 'Bearer cli-token' }), true)).toBe(true);
    expect(browserMutationAllowed(request('/api/fs/delete', 'GET', { origin: 'null' }))).toBe(true);
  });

  it('admits writes only from the configured desktop UI origin', () => {
    const trusted = 'notnative-ui://app';
    expect(browserMutationAllowed(request('/api/settings', 'PUT', {
      origin: trusted, 'sec-fetch-site': 'cross-site',
    }), false, trusted)).toBe(true);
    expect(browserMutationAllowed(request('/api/settings', 'PUT', {
      origin: 'notnative-ui://app.attacker', 'sec-fetch-site': 'cross-site',
    }), false, trusted)).toBe(false);
  });

  it('answers a credentialed CORS preflight only for the configured desktop origin', async () => {
    const original = process.env.NOTNATIVE_DESKTOP_UI_ORIGIN;
    process.env.NOTNATIVE_DESKTOP_UI_ORIGIN = 'notnative-ui://app';
    try {
      const app = createApp();
      const preflight = await app.fetch(new Request(`${TARGET}/api/settings`, { method: 'OPTIONS', headers: {
        origin: 'notnative-ui://app', 'access-control-request-method': 'PUT',
        'access-control-request-headers': 'authorization, content-type',
      } }));
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('notnative-ui://app');
      expect(preflight.headers.get('access-control-allow-credentials')).toBe('true');
      const denied = await app.fetch(new Request(`${TARGET}/api/settings`, { method: 'OPTIONS', headers: { origin: 'notnative-ui://app.attacker' } }));
      expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      if (original === undefined) delete process.env.NOTNATIVE_DESKTOP_UI_ORIGIN;
      else process.env.NOTNATIVE_DESKTOP_UI_ORIGIN = original;
    }
  });

  it('applies before NND API and auth routes, even in open-auth mode', async () => {
    const app = createApp();
    for (const path of ['/api/fs/delete', '/auth/session']) {
      const blocked = await app.fetch(request(path, 'POST', { origin: 'null', 'content-type': 'text/plain' }));
      expect(blocked.status).toBe(403);
      expect(await blocked.json()).toEqual({ error: 'Cross-origin browser write denied' });
    }
  });
});
