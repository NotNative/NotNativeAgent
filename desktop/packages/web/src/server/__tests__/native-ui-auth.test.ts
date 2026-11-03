// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUiAuthController, getUiAuthController, installNativeUiAuth, resetUiAuthForTests, socketPeer, upgradeAllowedForRequest, UI_SESSION_COOKIE } from '../lib/auth/ui-auth.ts';
import { verifySessionJwt } from '../lib/auth/jwt.ts';
import { createAuthRoutes } from '../routes/auth.ts';
import { Hono } from 'hono';
import { createClientAuthPublicRoutes, registerClientAuthRoutes } from '../routes/client-auth.ts';

const identity = { installationId: 'nna_'+'a'.repeat(64), dataId: 'data_'+'b'.repeat(64), generation: 'generation-1', origin: 'http://127.0.0.1:32145' };
const roots: string[] = [];
function controller(password = '', now?: () => number) {
  const dataDir = mkdtempSync(join(tmpdir(), 'nnd-native-auth-')); roots.push(dataDir);
  return createUiAuthController({ dataDir, nativeAuth: identity, resolvePassword: () => password, ...(now ? { now } : {}) });
}
function headers(cookie?: string): Headers { return new Headers({ origin: identity.origin, ...(cookie ? { cookie } : {}) }); }
const url = new URL(identity.origin+'/auth/native-bootstrap');
function cookie(action: { setCookie?: string }): string { return action.setCookie!.split(';')[0]!; }
function redeem(auth: ReturnType<typeof controller>) {
  const { ticket } = auth.nativeHandle()!.issueTicket();
  return auth.nativeBootstrap({ ticket }, headers(), url, '127.0.0.1');
}
afterEach(() => {
  resetUiAuthForTests(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe('supervised native UI authentication', () => {
  it('requires authentication without a password and rejects public desktop-token mint hints', () => {
    const auth = controller();
    expect(auth.passwordRequired()).toBe(false);
    expect(auth.authRequired()).toBe(true);
    expect(auth.authenticate(headers(), url, 'GET').ok).toBe(false);
    expect(auth.sessionStatus(headers(), url, 'GET').body).toMatchObject({ authRequired: true, methods: ['native-bootstrap'] });
    expect(auth.login({ headers: headers(), url, method: 'POST', ip: '127.0.0.1', body: { issueClientToken: true, clientKind: 'desktop-local' } }).status).toBe(401);
    const passwordAuth = controller('secret');
    const result = passwordAuth.login({ headers: headers(), url, method: 'POST', ip: '127.0.0.1', body: { password: 'secret', issueClientToken: true, clientKind: 'desktop-local' } });
    expect(result.status).toBe(200);
    expect(result.body.clientToken).toBeUndefined();
  });
  it('issues one-use tickets with HttpOnly Strict cookies and generation-specific signing', () => {
    vi.stubEnv('NOTNATIVE_JWT_SECRET', 'persistent-legacy-secret');
    const auth = controller();
    const { ticket } = auth.nativeHandle()!.issueTicket();
    const result = auth.nativeBootstrap({ ticket }, headers(), url, '127.0.0.1');
    expect(result.status).toBe(200);
    expect(result.setCookie).toContain('HttpOnly; SameSite=Strict');
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body).toEqual({ authenticated: true });
    expect(auth.nativeBootstrap({ ticket }, headers(), url, '127.0.0.1').status).toBe(401);
    const session = cookie(result);
    expect(auth.authenticate(headers(session), url, 'GET').ok).toBe(true);
    expect(controller().authenticate(headers(session), url, 'GET').ok).toBe(false);
    expect(verifySessionJwt('persistent-legacy-secret', session.split('=')[1], Date.now())).toBe(false);
  });
  it('bounds tickets, expiry, origin and actual socket scope', () => {
    let now = 100000;
    const auth = controller('', () => now);
    const tickets = Array.from({ length: 16 }, () => auth.nativeHandle()!.issueTicket().ticket);
    expect(() => auth.nativeHandle()!.issueTicket()).toThrow();
    for (const [requestHeaders, peer] of [[new Headers(), '127.0.0.1'], [headers(), undefined], [headers(), '192.168.1.3'],
      [new Headers({ origin: 'http://localhost:32145' }), '127.0.0.1'], [new Headers({ origin: identity.origin, 'x-forwarded-for': '127.0.0.1' }), '127.0.0.1']] as const) {
      expect(auth.nativeBootstrap({ ticket: tickets[0] }, requestHeaders, url, peer).status).toBe(401);
    }
    now += 60000;
    expect(auth.nativeBootstrap({ ticket: tickets[0] }, headers(), url, '127.0.0.1').status).toBe(401);
    expect(auth.nativeHandle()!.issueTicket().ticket.length).toBe(43);
  });
  it('revocation closes issuance, sessions, credential grants and websocket admission', () => {
    const auth = controller();
    const session = cookie(redeem(auth));
    const ticket = auth.nativeHandle()!.issueTicket();
    auth.nativeHandle()!.revoke();
    expect(auth.authenticate(headers(session), url, 'GET').ok).toBe(false);
    expect(auth.credentialGrant(headers(session), url, 'GET')).toBe(false);
    expect(auth.nativeBootstrap(ticket, headers(), url, '127.0.0.1').status).toBe(401);
    expect(() => auth.nativeHandle()!.issueTicket()).toThrow();
  });
  it('keeps passkey binding separate from transient session signing', () => {
    vi.stubEnv('NOTNATIVE_JWT_SECRET', 'existing-binding-secret');
    const first = controller('password'); const second = controller('password');
    expect(first.jwtSecretForBinding() === second.jwtSecretForBinding()).toBe(true);
    expect(second.authenticate(headers(cookie(redeem(first))), url, 'GET').ok).toBe(false);
  });
  it('rejects a persisted legacy device bearer in the native generation', () => {
    const auth = controller();
    const created = auth.getClientStore().createClient({ authMethod: 'password', clientKind: 'desktop-local', expiresAt: new Date(Date.now() + 60000).toISOString() });
    const request = new Headers({ authorization: `Bearer ${created.token}` });
    expect(auth.authenticate(request, url, 'GET').ok).toBe(false);
    expect(auth.credentialGrant(request, url, 'GET')).toBe(false);
  });
  it('redeems through the actual HTTP route and refuses oversized or replayed bodies', async () => {
    vi.stubEnv('NOTNATIVE_UI_PASSWORD', '');
    const binding = installNativeUiAuth(identity);
    const app = createAuthRoutes();
    const { ticket } = binding.controller.nativeHandle()!.issueTicket();
    const request = (body: unknown, peer: string | undefined = '127.0.0.1') => app.request(url.href, {
      method: 'POST', headers: { origin: identity.origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
    }, { incoming: { socket: { remoteAddress: peer } } });
    expect((await request({ ticket }, '192.168.1.5')).status).toBe(401);
    const response = await request({ ticket });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('SameSite=Strict');
    expect((await request({ ticket })).status).toBe(401);
    expect((await request({ ticket: 'a'.repeat(1100) })).status).toBe(401);
    expect((await app.request(identity.origin+'/auth/native-bootstrap')).status).toBe(404);
    binding.controller.close();
    expect(getUiAuthController().authRequired()).toBe(true);
    expect(upgradeAllowedForRequest(url, headers(response.headers.get('set-cookie')!), 'GET')).toBe(false);
    binding.release();
  });
  it('refuses silently replacing an initialized controller', () => {
    getUiAuthController();
    expect(() => installNativeUiAuth(identity)).toThrow('already initialized');
  });
  it('rejects native pairing and durable device mint routes explicitly', async () => {
    installNativeUiAuth(identity);
    const app = new Hono();
    app.route('/', createClientAuthPublicRoutes());
    registerClientAuthRoutes(app);
    for (const path of ['clients', 'pairing/sessions', 'pairing/redeem']) {
      const response = await app.request(identity.origin+'/api/client-auth/'+path, { method: 'POST' });
      expect(response.status).toBe(501);
      expect(await response.json()).toMatchObject({ code: 'native_device_attachment_unsupported' });
    }
  });
});

describe('desktop loopback exemption', () => {
  const status = (auth: ReturnType<typeof controller>, peer?: string) =>
    auth.sessionStatus(headers(), new URL(identity.origin + '/auth/session'), 'GET', peer);

  it('opens a connection from this machine without an access code, even with native mode on', () => {
    const auth = controller('');
    for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      const action = status(auth, peer);
      expect(action.status, peer).toBe(200);
      expect(action.body, peer).toMatchObject({ authenticated: true, scope: 'open', authRequired: false });
    }
  });

  it('keeps the access code for a connection from elsewhere', () => {
    const auth = controller('');
    const action = status(auth, '192.168.1.20');
    expect(action.status).toBe(401);
    expect(action.body).toMatchObject({ authenticated: false, locked: true });
  });

  it('keeps the access code when the peer is unknown', () => {
    const auth = controller('');
    expect(status(auth, undefined).status).toBe(401);
  });

  it('never trusts a forwarded header as the peer', () => {
    const auth = controller('');
    expect(auth.loopbackPeer('192.168.1.20')).toBe(false);
    expect(auth.loopbackPeer('127.0.0.1')).toBe(true);
    expect(auth.loopbackPeer(undefined)).toBe(false);
  });

  it('leaves nna serve gated: without native mode the password is still required', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nnd-native-auth-')); roots.push(dataDir);
    const serve = createUiAuthController({ dataDir, resolvePassword: () => 'hunter2' });
    const action = serve.sessionStatus(headers(), new URL(identity.origin + '/auth/session'), 'GET', '127.0.0.1');
    expect(action.status).toBe(401);
    expect(action.body).toMatchObject({ authenticated: false, locked: true, authRequired: true });
  });

  it('opens nna serve only when it has no password, as it did before', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nnd-native-auth-')); roots.push(dataDir);
    const serve = createUiAuthController({ dataDir, resolvePassword: () => '' });
    const action = serve.sessionStatus(headers(), new URL(identity.origin + '/auth/session'), 'GET', '192.168.1.20');
    expect(action.status).toBe(200);
    expect(action.body).toMatchObject({ authenticated: true, scope: 'open', authRequired: false });
  });

  it('lets a loopback /api request through the gate, which is where the UI actually asks', () => {
    const auth = controller('');
    const url = new URL(identity.origin + '/api/config/settings');
    expect(auth.authenticate(headers(), url, 'GET', true, '127.0.0.1').ok).toBe(true);
    expect(auth.authenticate(headers(), url, 'GET', true, '192.168.1.20').ok).toBe(false);
    expect(auth.authenticate(headers(), url, 'GET', true, undefined).ok).toBe(false);
  });

  it('keeps the gate closed for nna serve even from this machine', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nnd-native-auth-')); roots.push(dataDir);
    const serve = createUiAuthController({ dataDir, resolvePassword: () => 'hunter2' });
    const url = new URL(identity.origin + '/api/config/settings');
    expect(serve.authenticate(headers(), url, 'GET', true, '127.0.0.1').ok).toBe(false);
  });

  it('accepts the credential native mode does have from another machine, and the exemption never overrides it', () => {
    const auth = controller('');
    const url = new URL(identity.origin + '/api/config/settings');
    // Without a credential a foreign peer is refused, even though native mode is on.
    expect(auth.authenticate(new Headers({ origin: identity.origin }), url, 'GET', true, '192.168.1.20').ok).toBe(false);
    // The native-mode session ticket (a JWT cookie) still passes from anywhere.
    const ticket = auth.issueSessionToken(60_000).token;
    const credentialed = new Headers({ origin: identity.origin, cookie: `${UI_SESSION_COOKIE}=${ticket}` });
    expect(auth.authenticate(credentialed, url, 'GET', true, '192.168.1.20').ok).toBe(true);
  });

  it('reads the peer from the socket, not from a header', () => {
    expect(socketPeer({ incoming: { socket: { remoteAddress: '127.0.0.1' } } })).toBe('127.0.0.1');
    expect(socketPeer({ incoming: { socket: {} } })).toBeUndefined();
    expect(socketPeer({})).toBeUndefined();
    expect(socketPeer(undefined)).toBeUndefined();
  });
});
