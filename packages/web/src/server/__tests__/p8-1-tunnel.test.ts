// SPDX-License-Identifier: Apache-2.0
/**
 * P8-1 step 4 gates (doc 08 sections 2.9/4.5/4.7): tunnel scope
 * classification, newest-only bootstrap tokens, one-time /connect?t=
 * redeem with the Lax cookie, requireTunnelSession over the /api gate,
 * the tunnel-scope locks on /auth, stop/replace artifact revocation, and
 * the composed terminal upgrade predicate. Adversarial-review additions:
 * IPv4-mapped socket classification, ui-cookie/invalid-bearer fail-closed
 * probes at tunnel scope, open-mode URL-token rejection, connect-record
 * churn pins, and Secure-attribute coverage.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath, sep } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLEAR_SESSION_COOKIE_HEADER, UI_SESSION_COOKIE, resetUiAuthForTests, upgradeAllowedForRequest,
} from '../lib/auth/ui-auth.ts';
import {
  clampBootstrapTtl, clampSessionTtl, normalizedHost, TUNNEL_COOKIE_NAME, TUNNEL_REDEEM_FAILURE_TEXT,
  resetTunnelAuthForTests, getTunnelAuthController, createTunnelAuthController,
  type TunnelSession,
} from '../lib/auth/tunnel-auth.ts';
import { registerHarnessAdapter } from '../harness/adapter.ts';
import { mockHarness } from '../harness/mock/index.ts';

const isolatedDataDir = mkdtempSync(`${tmpdir()}${sep}nnd-p8-tunnel-`);
process.env.NOTNATIVE_DATA_DIR = isolatedDataDir;
delete process.env.NOTNATIVE_UI_PASSWORD;
const scratchDirs: string[] = [];
const originLocal = 'http://localhost';
const originTunnel = 'http://tunnel.example.com';
const ENV_LOOPBACK = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
const ENV_WAN = { incoming: { socket: { remoteAddress: '8.8.8.8' } } };

type App = { fetch: (request: Request, env?: unknown) => Promise<Response> };
let appInstance: App | null = null;

beforeAll(async () => {
  const { createApp } = await import('../app.ts');
  registerHarnessAdapter(mockHarness);
  const created = createApp();
  appInstance = { fetch: (request: Request, env?: unknown) => Promise.resolve(created.fetch(request, env as never)) };
});

afterAll(() => {
  rmSync(isolatedDataDir, { recursive: true, force: true });
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  delete process.env.NOTNATIVE_UI_PASSWORD;
});

function freshScratch(): string {
  const made = mkdtempSync(`${tmpdir()}${sep}nnd-p8t-`);
  scratchDirs.push(made);
  return made;
}

async function call(path: string, init?: RequestInit, env?: unknown): Promise<Response> {
  const request = new Request(`${originLocal}${path}`, init);
  return (appInstance as App).fetch(request, env ?? ENV_LOOPBACK);
}

async function callTunnelHost(path: string, init?: RequestInit, wan = false): Promise<Response> {
  const request = new Request(`${originTunnel}${path}`, init);
  return (appInstance as App).fetch(request, wan ? ENV_WAN : ENV_LOOPBACK);
}

function setCookies(response: Response): string[] {
  const accessor = (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  return typeof accessor === 'function' ? accessor.call(response.headers) : [];
}

function cookieValue(response: Response, name: string): string | null {
  for (const cookie of setCookies(response)) {
    if (cookie.startsWith(`${name}=`)) return cookie.slice(name.length + 1).split(';')[0] ?? null;
  }
  return null;
}

function armTunnel(options?: { publicUrl?: string; mode?: string }): { tunnelId: string; token: string } {
  const tunnel = getTunnelAuthController();
  tunnel.setActiveTunnel({ publicUrl: options?.publicUrl ?? 'https://tunnel.example.com', mode: options?.mode ?? 'quick' });
  const active = tunnel.activeTunnel()!;
  const issued = tunnel.issueBootstrapToken();
  return { tunnelId: active.tunnelId, token: issued.token };
}

describe('tunnel scope classification + clamps (doc 08 section 2.9/4.5)', () => {
  it('clamps follow the doc bounds; null disables bootstrap expiry', () => {
    expect(clampBootstrapTtl(undefined)).toMatchObject({ enabled: true, ms: 30 * 60_000 });
    expect(clampBootstrapTtl(100)).toMatchObject({ enabled: true, ms: 60_000 });
    expect(clampBootstrapTtl(10 * 24 * 60 * 60_000)).toMatchObject({ enabled: true, ms: 24 * 60 * 60_000 });
    expect(clampBootstrapTtl(null).enabled).toBe(false);
    expect(clampSessionTtl(undefined)).toBe(8 * 60 * 60_000);
    expect(clampSessionTtl(1000)).toBe(5 * 60_000);
    expect(clampSessionTtl(365 * 24 * 60 * 60_000)).toBe(30 * 24 * 60 * 60_000);
    expect(normalizedHost('TUNNEL.Example.COM:8443')).toBe('tunnel.example.com');
    expect(normalizedHost('[::1]:5180')).toBe('::1');
    expect(normalizedHost(undefined)).toBe('');
  });

  it('classifiers: no tunnel is always local; tunnel host wins; local names need private sockets', () => {
    let clock = 1000;
    const tunnel = createTunnelAuthController({ now: () => clock });
    const headers = (host: string): Headers => new Headers({ host });
    const url = (host: string): URL => new URL(`http://${host}/api/session`);
    expect(tunnel.classify(headers('anything.example.com'), url('anything.example.com'), '8.8.8.8')).toBe('local');
    tunnel.setActiveTunnel({ publicUrl: 'https://Tunnel.Example.com', mode: 'quick' });
    expect(tunnel.classify(headers('tunnel.example.com:443'), url('tunnel.example.com'), undefined)).toBe('tunnel');
    expect(tunnel.classify(headers('TUNNEL.EXAMPLE.COM'), url('tunnel.example.com'), undefined)).toBe('tunnel');
    expect(tunnel.classify(headers('localhost'), url('localhost'), '127.0.0.1')).toBe('local');
    expect(tunnel.classify(headers('localhost'), url('localhost'), '192.168.10.5')).toBe('local');
    expect(tunnel.classify(headers('localhost'), url('localhost'), '8.8.8.8')).toBe('unknown-public');
    expect(tunnel.classify(headers('gatekeeper.example.net'), url('gatekeeper.example.net'), '10.9.8.7')).toBe('unknown-public'); // private socket only rescues local names
    expect(tunnel.classify(headers('gatekeeper.example.net'), url('gatekeeper.example.net'), undefined)).toBe('unknown-public');
    expect(tunnel.classify(headers('tunnel.example.com'), new URL('http://tunnel.example.com'), '8.8.8.8')).toBe('tunnel');
  });

  it('classifies IPv4-mapped sockets as their IPv4 space (dual-stack binds)', () => {
    let clock = 1000;
    const tunnel = createTunnelAuthController({ now: () => clock });
    tunnel.setActiveTunnel({ publicUrl: 'https://tunnel.example.com', mode: 'quick' });
    const headers = new Headers({ host: 'localhost' });
    const url = new URL('http://localhost/');
    // the desktop's own dual-stack loopback peer is still the desktop host
    expect(tunnel.classify(headers, url, '::ffff:127.0.0.1')).toBe('local');
    // mapped RFC1918/link-local peers are private -> local for local names
    expect(tunnel.classify(headers, url, '::ffff:192.168.10.77')).toBe('local');
    expect(tunnel.classify(headers, new URL('http://localhost/'), '::FFFF:10.1.2.3')).toBe('local'); // case-insensitive prefix
    expect(tunnel.classify(new Headers({ host: 'localhost' }), url, '::ffff:172.16.0.9')).toBe('local');
    expect(tunnel.classify(new Headers({ host: 'localhost' }), url, '::ffff:169.254.9.9')).toBe('local');
    // a mapped public peer stays public
    expect(tunnel.classify(headers, url, '::ffff:8.8.8.8')).toBe('unknown-public');
    expect(tunnel.classify(headers, url, '192.168.10.77')).toBe('local'); // plain-v4 sanity
    expect(tunnel.classify(headers, url, '::ffff:999.999.999.999')).toBe('unknown-public'); // invalid octets stay public
  });

  it('garbage cookie headers and empty values resolve to no tunnel session', () => {
    const tunnel = createTunnelAuthController({ now: () => 1000 });
    expect(tunnel.sessionFromCookie(undefined)).toBeNull();
    expect(tunnel.sessionFromCookie(null)).toBeNull();
    expect(tunnel.sessionFromCookie('')).toBeNull();
    expect(tunnel.sessionFromCookie('nonsense; ==; ===; more')).toBeNull();
    expect(tunnel.sessionFromCookie('oc_tunnel_session=')).toBeNull();
    expect(tunnel.sessionFromCookie('oc_tunnel_session= ; Path=/')).toBeNull();
    expect(tunnel.sessionFromCookie('oc_tunnel_session=does-not-exist')).toBeNull();
  });

  it('bootstrap tokens: newest-only, clamped expiry, null-expiry honored, one-shot redeem', () => {
    let clock = 1000;
    const tunnel = createTunnelAuthController({ now: () => clock, bootstrapTtlMs: 60_000, sessionTtlMs: 300_000 });
    expect(() => tunnel.issueBootstrapToken()).toThrow(/active tunnel/u);
    tunnel.setActiveTunnel({ publicUrl: 'https://tunnel.example.com', mode: 'quick' });
    const first = tunnel.issueBootstrapToken();
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/u); // 32B base64url
    expect(first.record.expiresAt).toBe(new Date(1000 + 60_000).toISOString());
    clock = 2000;
    const second = tunnel.issueBootstrapToken();
    expect(second.record.revokedAt).toBeNull(); // fresh token is live
    expect(first.record.revokedAt).toBe(new Date(2000).toISOString()); // first was revoked by issuance
    // newest-only: the first token can no longer redeem
    expect(tunnel.redeemToken(first.token).ok).toBe(false);
    expect(second.record.usedAt).toBeNull();
    const ok = tunnel.redeemToken(second.token);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.session.sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(ok.cookieValue.startsWith(TUNNEL_COOKIE_NAME)).toBe(true);
      expect(ok.cookieValue).toContain('HttpOnly');
      expect(ok.cookieValue).toContain('SameSite=Lax');
      expect(ok.cookieValue).toContain('Max-Age=300');
      expect(ok.session.tunnelId).toBe(tunnel.activeTunnel()!.tunnelId);
      // mint-then-consume order (doc 08 section 4.5): the session record exists
      // in the map together with the usedAt stamp, never one without the other
      expect(tunnel.sessionList()).toContainEqual(ok.session);
      expect(tunnel.sessionList()).toHaveLength(1);
    }
    expect(tunnel.redeemToken(second.token).ok).toBe(false); // used
    clock += 30 * 60_000;
    tunnel.setActiveTunnel({ publicUrl: 'https://tunnel.example.com', mode: 'quick' });
    const third = tunnel.issueBootstrapToken();
    clock += 30 * 60_000;
    expect(tunnel.redeemToken(third.token).ok).toBe(false); // expired (clamped to 60 s)

    const endless = createTunnelAuthController({ now: () => clock, bootstrapTtlMs: null });
    endless.setActiveTunnel({ publicUrl: 'https://tunnel.example.com', mode: 'quick' });
    const open = endless.issueBootstrapToken();
    expect(open.record.expiresAt).toBeNull();
    expect(endless.redeemToken(open.token).ok).toBe(true);
  });

  it('sessions: cookie lookup, lastSeenAt refresh, revoked/wrong-tunnel/expired rejection', () => {
    let clock = 1000;
    const tunnel = createTunnelAuthController({ now: () => clock, sessionTtlMs: 299_000 });
    tunnel.setActiveTunnel({ publicUrl: 'https://tunnel.example.com', mode: 'quick' });
    const { token, record } = tunnel.issueBootstrapToken();
    const grant = tunnel.redeemToken(token);
    expect(grant.ok).toBe(true);
    const session: TunnelSession = grant.ok ? grant.session : ({} as TunnelSession);
    const typed = grant.ok ? (grant as { cookieValue: string }) : { cookieValue: '' };
    expect(record.usedAt).toBe(new Date(1000).toISOString());
    clock = 5000;
    expect(tunnel.sessionFromCookie(`oc_ui_session=other; ${typed.cookieValue}`)?.sessionId).toBe(session.sessionId);
    expect(session.lastSeenAt).toBe(new Date(5000).toISOString());
    clock += 299_000;
    expect(tunnel.sessionFromCookie(typed.cookieValue)).toBeNull(); // expired
    clock = 6000;
    expect(tunnel.requireTunnelSession(typed.cookieValue)).toBe(true);
    const revoked = tunnel.revokeTunnelArtifacts(tunnel.activeTunnel()!.tunnelId);
    expect(revoked.invalidatedSessionCount).toBe(1);
    expect(session.revokedReason).toBe('tunnel-revoked');
    expect(tunnel.sessionFromCookie(typed.cookieValue)).toBeNull();
    tunnel.clearActiveTunnel();
    expect(tunnel.sessionList()).toHaveLength(1); // revoked records stay listed
  });

  it('stop/replace: clearActiveTunnel revokes + nulls; wrong-tunnel sessions die with the new id', () => {
    let clock = 1000;
    const tunnel = createTunnelAuthController({ now: () => clock });
    tunnel.setActiveTunnel({ publicUrl: 'https://a.example.com', mode: 'quick' });
    const { token, record } = tunnel.issueBootstrapToken();
    const grant = tunnel.redeemToken(token);
    expect(grant.ok).toBe(true);
    // replacement: host changed -> new tunnel id + artifact revoke for the old one
    clock = 2000;
    const cleared = tunnel.clearActiveTunnel();
    expect(cleared.revokedBootstrapCount).toBe(1);
    expect(record.revokedAt).toBe(new Date(2000).toISOString());
    expect(cleared.invalidatedSessionCount).toBe(1);
    expect(tunnel.activeTunnel()).toBeNull();
    expect(tunnel.redeemToken(token).ok).toBe(false); // no active tunnel
    tunnel.setActiveTunnel({ publicUrl: 'https://b.example.com', mode: 'managed' });
    tunnel.setActiveTunnel({ publicUrl: 'https://c.example.com', mode: 'quick' });
    expect(tunnel.redeemToken(token).ok).toBe(false); // token-tunnel mismatch
  });

  it('connect rate limit: 20/5min per IP, 5 without IP, 10min lock out', () => {
    const tunnel = createTunnelAuthController({ now: () => 1000 });
    tunnel.setActiveTunnel({ publicUrl: 'https://tunnel.example.com', mode: 'quick' });
    const headers = new Headers({ 'x-forwarded-for': '9.9.9.9' });
    for (let index = 0; index < 20; index++) {
      tunnel.redeemToken('bogus');
      tunnel.recordConnectFailure(headers);
    }
    const blocked = tunnel.attemptConnect(headers);
    expect(blocked.allowed).toBe(false);
    expect(blocked.headers['x-ratelimit-limit']).toBe('20');
    expect(blocked.headers['retry-after']).toBe('600');
    const narrow: Headers = new Headers();
    for (let index = 0; index < 5; index++) {
      tunnel.redeemToken('bogus');
      tunnel.recordConnectFailure(narrow);
    }
    expect(tunnel.attemptConnect(narrow).allowed).toBe(false);
  });
});

describe('tunnel routes + gate (singleton app)', () => {
  beforeEach(() => {
    resetTunnelAuthForTests();
    resetUiAuthForTests();
  });

  it('/connect?t= one-time: 302 to / with the Lax cookie; second use 401 exact text; failures record', async () => {
    const { token } = armTunnel();
    const ok = await call(`/connect?t=${token}`);
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toBe('/');
    expect(ok.headers.get('cache-control')).toBe('no-store');
    const cookie = setCookies(ok).find((value) => value.startsWith(`${TUNNEL_COOKIE_NAME}=`))!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookieValue(ok, TUNNEL_COOKIE_NAME)).toBeTruthy();
    expect((await call(`/connect?t=${token}`)).status).toBe(401); // already used
    const bad = await call('/connect?t=nope');
    expect(bad.status).toBe(401);
    expect(await bad.text()).toBe(TUNNEL_REDEEM_FAILURE_TEXT);
  });

  it('/api at tunnel scope: session cookie required, bearer/URL-token pass, ui cookie ignored', async () => {
    armTunnel();
    const denied = await callTunnelHost('/api/config/settings?surface=web');
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ error: 'Tunnel authentication required', locked: true, tunnelLocked: true });
    expect(denied.headers.get('cache-control')).toBe('no-store');
    const entrance = await callTunnelHost(`/connect?t=${armTunnelOnce()}`);
    const tunnelCookie = `${TUNNEL_COOKIE_NAME}=${cookieValue(entrance, TUNNEL_COOKIE_NAME)}`;
    const admitted = await callTunnelHost('/api/config/settings?surface=web', { headers: { cookie: tunnelCookie } });
    expect(admitted.status).toBe(200);
    // a LAN ui session cookie does NOT open the tunnel gate
    const session = await call('/auth/session', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '3.0.0.1' }, body: JSON.stringify({ password: 'x' }) });
    expect(session.status).toBe(200); // open-mode local login path answers (tunnel parked on another host)
    // device bearer rides any scope: mint through the SAME controller store
    const device = await mintViaLogin('9.1.1.1');
    const bearer = await callTunnelHost('/auth/session', { headers: { authorization: `Bearer ${device}` } }, true);
    expect(bearer.status).toBe(200);
    expect(await bearer.json()).toMatchObject({ authenticated: true, scope: 'client' });
    const urlMint = await callTunnelHost('/auth/url-token', { method: 'POST', headers: { authorization: `Bearer ${device}` } }, true);
    expect(urlMint.status).toBe(200); // the mint rides the tunnel for device bearers
    const boundToken = (await urlMint.json() as { token: string }).token;
    writeFileSync(joinPath(isolatedDataDir, 'tunnel-probe.txt'), 'tunnel');
    const tokenGate = await callTunnelHost(`/api/fs/raw?path=tunnel-probe.txt&directory=${encodeURIComponent(isolatedDataDir)}&oc_url_token=${boundToken}`, undefined, true);
    expect(tokenGate.status).toBe(200); // client-bound URL tokens replay the device authority on allowlisted targets
    const tokenGateSettings = await callTunnelHost('/api/config/settings?surface=web&oc_url_token=' + boundToken, undefined, true);
    expect(tokenGateSettings.status).toBe(401); // non-allowlisted target: the URL token falls through
  });

  it('/auth/session at tunnel scope: 401 tunnelLocked + cookie clear, tunnel session 200, login locked', async () => {
    armTunnel();
    const { cookieValue: entranceCookie } = await redeemEntrance();
    const denied = await callTunnelHost('/auth/session');
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ authenticated: false, locked: true, tunnelLocked: true });
    const session = await callTunnelHost('/auth/session', { headers: { cookie: entranceCookie } });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ authenticated: true, scope: 'tunnel' });
    const login = await callTunnelHost('/auth/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'x' }) });
    expect(login.status).toBe(403);
    expect(await login.json()).toMatchObject({ error: 'Password login is disabled for tunnel scope', tunnelLocked: true });
    const reset = await callTunnelHost('/api/auth/reset', { method: 'POST' });
    expect(reset.status).toBe(403);
    expect(await reset.json()).toMatchObject({ error: 'Global auth reset is disabled for tunnel scope', tunnelLocked: true });
    const mint = await callTunnelHost('/auth/url-token', { method: 'POST' });
    expect(mint.status).toBe(401);
  });

  it('ui session cookies and invalid device bearers never open the tunnel gate', async () => {
    process.env.NOTNATIVE_UI_PASSWORD = 'correct horse';
    resetUiAuthForTests();
    try {
      armTunnel();
      const loggedIn = await call('/auth/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '4.4.4.4' },
        body: JSON.stringify({ password: 'correct horse' }),
      });
      expect(loggedIn.status).toBe(200);
      const uiCookie = `${UI_SESSION_COOKIE}=${cookieValue(loggedIn, UI_SESSION_COOKIE)}`;
      const gate = await callTunnelHost('/api/config/settings?surface=web', { headers: { cookie: uiCookie } });
      expect(gate.status).toBe(401); // an account JWT cookie is not a tunnel credential
      expect(await gate.json()).toMatchObject({ error: 'Tunnel authentication required', locked: true, tunnelLocked: true });
      const probe = await callTunnelHost('/auth/session', { headers: { cookie: uiCookie } });
      expect(probe.status).toBe(401);
      expect(await probe.json()).toMatchObject({ authenticated: false, locked: true, tunnelLocked: true });
      // the invalid ui cookie still gets the clear-on-invalid discipline (E-08-17)
      expect(setCookies(probe)).toContain(CLEAR_SESSION_COOKIE_HEADER);
      const badBearer = await callTunnelHost('/api/config/settings?surface=web', { headers: { authorization: 'Bearer oc_client_never-issued' } }, true);
      expect(badBearer.status).toBe(401); // fail-closed: an invalid bearer does not fall through to anything
      expect(await badBearer.json()).toMatchObject({ error: 'Tunnel authentication required', tunnelLocked: true });
    } finally {
      delete process.env.NOTNATIVE_UI_PASSWORD;
      resetUiAuthForTests();
    }
  });

  it('an open-mode URL token never opens a tunnel-scope allowlisted target', async () => {
    armTunnel();
    const mint = await call('/auth/url-token', { method: 'POST', headers: { 'x-forwarded-for': '2.2.2.2' } });
    expect(mint.status).toBe(200); // local open-mode mint is fine
    const token = (await mint.json() as { token?: string }).token ?? '';
    expect(token).toMatch(/^oc_url_/u);
    writeFileSync(joinPath(isolatedDataDir, 'tunnel-open.txt'), 'open');
    // parent "" resolves to nothing: the anonymous-browser pass never crosses a tunnel
    const denied = await callTunnelHost(`/api/fs/raw?path=tunnel-open.txt&directory=${encodeURIComponent(isolatedDataDir)}&oc_url_token=${token}`, undefined, true);
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ error: 'Tunnel authentication required', tunnelLocked: true });
  });

  it('connect cookie: exactly one Set-Cookie, Secure behind https, 401 keeps no-store', async () => {
    const { token } = armTunnel();
    const plain = await call(`/connect?t=${token}`);
    expect(plain.status).toBe(302);
    expect(setCookies(plain)).toHaveLength(1);
    const { token: second } = armTunnel();
    const secure = await call(`/connect?t=${second}`, { headers: { 'x-forwarded-proto': 'https' } });
    expect(secure.status).toBe(302);
    expect(setCookies(secure).find((value) => value.startsWith(`${TUNNEL_COOKIE_NAME}=`))!).toContain('Secure');
    const bad = await call('/connect?t=nope', { headers: { 'x-forwarded-proto': 'https' } });
    expect(bad.status).toBe(401); // failures clear nothing (E-08-17) and stay no-store
    expect(bad.headers.get('cache-control')).toBe('no-store');
    expect(setCookies(bad)).toHaveLength(0);
  });

  it('connect route records failures only on invalid redeems; rate-blocked attempts record nothing', async () => {
    armTunnel();
    const tunnel = getTunnelAuthController();
    const record = vi.spyOn(tunnel, 'recordConnectFailure');
    const headers = { 'x-forwarded-for': '3.3.3.3' };
    for (let index = 0; index < 20; index++) {
      const failing = await call('/connect?t=bogus', { headers });
      expect(failing.status).toBe(401);
    }
    expect(record).toHaveBeenCalledTimes(20);
    for (let index = 0; index < 6; index++) {
      const blocked = await call('/connect?t=bogus', { headers });
      expect(blocked.status).toBe(429); // threshold request + locked window
    }
    expect(record).toHaveBeenCalledTimes(20); // the 429s added zero churn
    vi.restoreAllMocks();
  });

  it('terminal upgrade composes a device URL token at tunnel scope via the WS allowlist', async () => {
    armTunnel();
    expect(upgradeAllowedForRequest(new URL('http://tunnel.example.com/api/terminal/ws'), new Headers(), 'GET')).toBe(false);
    const device = await mintViaLogin('8.2.1.4');
    const mint = await callTunnelHost('/auth/url-token', { method: 'POST', headers: { authorization: `Bearer ${device}` } }, true);
    expect(mint.status).toBe(200);
    const token = (await mint.json() as { token?: string }).token ?? '';
    const admitted = upgradeAllowedForRequest(
      new URL(`http://tunnel.example.com/api/terminal/ws?oc_url_token=${token}`),
      new Headers({ upgrade: 'websocket' }),
      'GET',
    );
    expect(admitted).toBe(true); // client-bound URL tokens count as device credentials
  });

  it('scope partitioning honors the local path with a tunnel active elsewhere', async () => {
    armTunnel();
    const local = await call('/api/config/settings?surface=web', { headers: { host: 'localhost' } });
    expect(local.status).toBe(200); // localhost + loopback socket stays local
  });

  it('stop: artifacts die, old sessions reject, host falls back to local', async () => {
    const { token, tunnelId } = armTunnel();
    const entrance = await call(`/connect?t=${token}`);
    const tunnelCookie = `${TUNNEL_COOKIE_NAME}=${cookieValue(entrance, TUNNEL_COOKIE_NAME)}`;
    expect((await callTunnelHost('/api/config/settings?surface=web', { headers: { cookie: tunnelCookie } })).status).toBe(200);
    const stop = getTunnelAuthController().clearActiveTunnel();
    expect(stop.invalidatedSessionCount).toBe(1);
    expect(stop.revokedBootstrapCount).toBe(1);
    expect((await call(`/connect?t=${token}`)).status).toBe(401);
    const after = await callTunnelHost('/api/config/settings?surface=web', { headers: { cookie: tunnelCookie } });
    expect(after.status).toBe(200); // no active tunnel -> scope local -> open
    void tunnelId;
  });

  it('connect rate limit at the route: 429 + Retry-After after the budget', async () => {
    armTunnel();
    const headers = { 'x-forwarded-for': '7.7.7.7' };
    let last: Response | null = null;
    for (let index = 0; index < 21; index++) {
      last = await call('/connect?t=bogus', { headers });
    }
    expect(last!.status).toBe(429);
    expect(last!.headers.get('retry-after')).toBe('600');
    expect(last!.headers.get('x-ratelimit-limit')).toBe('20');
  });

  it('terminal upgrade predicate composes ui + tunnel answers', async () => {
    const { upgradeAllowedForRequest } = await import('../lib/auth/ui-auth.ts');
    armTunnel();
    expect(upgradeAllowedForRequest(new URL('http://tunnel.example.com/api/terminal/ws'), new Headers(), 'GET')).toBe(false);
    const { cookieValue: entranceCookie } = await redeemEntrance();
    expect(upgradeAllowedForRequest(new URL('http://tunnel.example.com/api/terminal/ws'), new Headers({ cookie: entranceCookie }), 'GET')).toBe(true);
    expect(upgradeAllowedForRequest(new URL('http://localhost/api/terminal/ws'), new Headers(), 'GET')).toBe(true);
  });
});

function armTunnelOnce(): string {
  return armTunnel().token; // always fresh against the per-test controller
}

async function redeemEntrance(): Promise<{ cookieValue: string; entranceCookie: string }> {
  const token = armTunnelOnce();
  const entrance = await callTunnelHost(`/connect?t=${token}`, undefined, false);
  expect(entrance.status).toBe(302);
  const value = cookieValue(entrance, TUNNEL_COOKIE_NAME)!;
  return { cookieValue: `${TUNNEL_COOKIE_NAME}=${value}`, entranceCookie: value };
}

async function mintViaLogin(ip: string): Promise<string> {
  const minted = await call('/auth/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ issueClientToken: true, clientKind: 'desktop', dedupeKey: `mint-${ip}` }),
  });
  const body = await minted.json() as { clientToken?: string };
  expect(body.clientToken ?? '').toMatch(/^oc_client_/u);
  return body.clientToken!;
}
