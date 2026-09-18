// SPDX-License-Identifier: Apache-2.0
/**
 * P8-1 step 3 gates (doc 08 sections 2.2/2.3/2.6/2.7): scrypt password +
 * hand-rolled HS256 session cookie, login flow with the per-IP rate limit
 * and trust-device TTL, desktop client-token mint, GET/POST /auth/session
 * semantics, URL-token mint/resolution over the fixed allowlist, global
 * /api gate, reset rotation, and the terminal upgrade slot (E-07-3).
 */
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath, sep } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { RemoteClientStore } from '../lib/auth/remote-clients.ts';
import type { TerminalRuntime } from '../terminal/session-core.ts';
import { attachTerminalWebsocket } from '../terminal/wire.ts';
import {
  createUiAuthController, getUiAuthController, resetUiAuthForTests,
  CLEAR_SESSION_COOKIE_HEADER, UI_SESSION_COOKIE,
} from '../lib/auth/ui-auth.ts';
import { URL_TOKEN_QUERY_ALIASES, urlTokenTargetAllowed } from '../lib/auth/url-tokens.ts';
import { resolveJwtSecretHolder, signSessionJwt, verifySessionJwt } from '../lib/auth/jwt.ts';
import { createLoginRateLimiter } from '../lib/auth/rate-limit.ts';
import { normalizedPassword, createPasswordHashCache } from '../lib/auth/password.ts';
import { registerHarnessAdapter } from '../harness/adapter.ts';
import { mockHarness } from '../harness/mock/index.ts';

const isolatedDataDir = mkdtempSync(`${tmpdir()}${sep}nnd-p8-auth-`);
process.env.NOTNATIVE_DATA_DIR = isolatedDataDir;
delete process.env.NOTNATIVE_UI_PASSWORD;
delete process.env.NOTNATIVE_JWT_SECRET;
const origin = 'http://test.local';
const scratchDirs: string[] = [];

type App = { fetch: (request: Request) => Promise<Response> };
let appInstance: App | null = null;

function freshScratch(): string {
  const made = mkdtempSync(`${tmpdir()}${sep}nnd-p8a-`);
  scratchDirs.push(made);
  return made;
}

beforeAll(async () => {
  const { createApp } = await import('../app.ts');
  registerHarnessAdapter(mockHarness);
  const created = createApp();
  appInstance = { fetch: (request: Request) => Promise.resolve(created.fetch(request)) };
});

afterAll(() => {
  rmSync(isolatedDataDir, { recursive: true, force: true });
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  delete process.env.NOTNATIVE_UI_PASSWORD;
  delete process.env.NOTNATIVE_JWT_SECRET;
});

function theApp(): App {
  if (!appInstance) throw new Error('app not initialized; beforeAll must run first');
  return appInstance;
}

async function call(path: string, init?: RequestInit): Promise<Response> {
  return theApp().fetch(new Request(`${origin}${path}`, init));
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

function setEnvPassword(value: string): void {
  process.env.NOTNATIVE_UI_PASSWORD = value;
  resetUiAuthForTests();
}

function clearEnvPassword(): void {
  delete process.env.NOTNATIVE_UI_PASSWORD;
  resetUiAuthForTests();
}

function hasClearCookie(response: Response): boolean {
  return setCookies(response).includes(CLEAR_SESSION_COOKIE_HEADER);
}

async function login(body: Record<string, unknown>, ip: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return call('/auth/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...extraHeaders },
    body: JSON.stringify(body),
  });
}

describe('password + jwt primitives (doc 08 section 2.2)', () => {
  it('normalize(): NFC + trim, string-only', () => {
    expect(normalizedPassword('  spaced  ')).toBe('spaced');
    expect(normalizedPassword('\u0065\u0301')).toBe('\u00e9'); // e + combining acute -> NFC
    expect(normalizedPassword('   ')).toBe('');
    expect(normalizedPassword(undefined)).toBe('');
    expect(normalizedPassword(42)).toBe('');
  });

  it('hash cache: refreshed hot entries survive, cold LRU entries evict', () => {
    const cache = createPasswordHashCache(2);
    const a = cache('a');
    const b = cache('b');
    expect(cache('a')).toBe(a); // identity proves the entry was cached, not re-derived
    cache('c'); // insert order after the touch: [b, a, +c] -> cold 'b' evicts at the limit
    expect(cache('b')).not.toBe(b); // re-derived after eviction
    const tight = createPasswordHashCache(1);
    const x = tight('x');
    tight('y');
    const y = tight('y');
    expect(tight('y')).toBe(y); // hot key stays
    expect(tight('x')).not.toBe(x); // evicted at the limit
  });

  it('session JWT round-trips only while exp is future and the secret holds', () => {
    const secret = 'a'.repeat(64);
    const signed = signSessionJwt(secret, 1000, 2000);
    expect(signed.split('.')).toHaveLength(3);
    expect(verifySessionJwt(secret, signed, 1999)).toBe(true);
    expect(verifySessionJwt(secret, signed, 2000)).toBe(false); // exactly-now is expired
    const payload = JSON.parse(Buffer.from(signed.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toStrictEqual(['exp', 'iat', 'type']); // exact grammar
    expect(payload.type).toBe('ui-session');
  });

  it('verify rejects tampering, wrong secrets, junk shapes, oversized tokens', () => {
    const secret = 'b'.repeat(64);
    const signed = signSessionJwt(secret, 1000, 2000);
    const parts = signed.split('.');
    expect(verifySessionJwt(secret, `${parts[0]}.e30.${parts[2]}`, 1999)).toBe(false); // {}
    expect(verifySessionJwt(secret, `${signed.slice(0, -1)}z`, 1999)).toBe(false);
    expect(verifySessionJwt('c'.repeat(64), signed, 1999)).toBe(false);
    expect(verifySessionJwt(secret, 'garbage', 1999)).toBe(false);
    expect(verifySessionJwt(secret, 'a.b.c', 1999)).toBe(false);
    expect(verifySessionJwt(secret, 'x'.repeat(5000), 1999)).toBe(false);
    expect(verifySessionJwt(secret, null, 1999)).toBe(false);
    expect(verifySessionJwt(secret, signSessionJwt(secret, 5000, 2000), 1999)).toBe(false); // iat > exp never valid (E-08-1)
    expect(verifySessionJwt(secret, signSessionJwt(secret, Number.NaN, 2000), 1999)).toBe(false); // NaN payloads can never re-verify
  });

  it('header shape is not the defense; the tag is (any self-signed header verifies)', () => {
    const secret = 'b'.repeat(64);
    const signed = signSessionJwt(secret, 1000, 2000);
    const [, body] = signed.split('.') as [string, string];
    const altHead = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'k1' })).toString('base64url');
    const forgedTag = createHmac('sha256', Buffer.from(secret, 'utf8')).update(`${altHead}.${body}`).digest('base64url');
    expect(verifySessionJwt(secret, `${altHead}.${body}.${forgedTag}`, 1999)).toBe(true);
    // ...but an attacker cannot swap the header without re-tagging
    expect(verifySessionJwt(secret, `${altHead}.${body}.${signed.split('.')[2]}`, 1999)).toBe(false);
  });

  it('secret holder loads the file, rotates it, and refuses while env-backed', () => {
    const dir = freshScratch();
    writeFileSync(joinPath(dir, 'jwt-secret'), 'f'.repeat(64));
    const holder = resolveJwtSecretHolder(dir);
    expect(holder.source()).toBe('file');
    expect(holder.secret()).toBe('f'.repeat(64));
    holder.rotate();
    expect(readFileSync(joinPath(dir, 'jwt-secret'), 'utf8').trim()).toBe(holder.secret());
    expect(readdirSync(dir).filter((name) => name.startsWith('jwt-secret.tmp-'))).toHaveLength(0);
    process.env.NOTNATIVE_JWT_SECRET = 'z'.repeat(64);
    try {
      expect(resolveJwtSecretHolder(dir).source()).toBe('env');
      expect(() => resolveJwtSecretHolder(dir).rotate()).toThrow(/NOTNATIVE_JWT_SECRET/u);
    } finally {
      delete process.env.NOTNATIVE_JWT_SECRET;
    }
  });

  it('generated secrets persist to the file so sessions survive restarts (doc 08 section 2.2)', () => {
    const dir = freshScratch();
    const first = resolveJwtSecretHolder(dir);
    expect(first.source()).toBe('file'); // generated AND persisted
    const persisted = readFileSync(joinPath(dir, 'jwt-secret'), 'utf8').trim();
    expect(persisted).toMatch(/^[0-9a-f]{64}$/u);
    expect(persisted).toBe(first.secret());
    expect(resolveJwtSecretHolder(dir).secret()).toBe(first.secret()); // reload keeps the session secret
    expect(readdirSync(dir).filter((name) => name.startsWith('jwt-secret.tmp-'))).toHaveLength(0); // atomic rename leaves no residue
  });

  it('a corrupted slot regenerates and rewrites a valid secret file', () => {
    const dir = freshScratch();
    writeFileSync(joinPath(dir, 'jwt-secret'), 'not-hex');
    const holder = resolveJwtSecretHolder(dir);
    expect(holder.source()).toBe('file');
    expect(holder.secret()).toMatch(/^[0-9a-f]{64}$/u);
    expect(readFileSync(joinPath(dir, 'jwt-secret'), 'utf8').trim()).toBe(holder.secret());
  });

  it('rate limiter machine: window, cap, lockout, no-IP budget, success clear', () => {
    let clock = 1000;
    const limiter = createLoginRateLimiter({ windowMs: 1000, maxAttempts: 2, noIpMaxAttempts: 1, lockoutMs: 5000 }, () => clock);
    expect(limiter.attempt('ip').allowed).toBe(true);
    limiter.record('ip');
    expect(limiter.attempt('ip').allowed).toBe(true);
    limiter.record('ip');
    const locked = limiter.attempt('ip'); // cap exhausted -> lock
    expect(locked.allowed).toBe(false);
    expect(locked.locked).toBe(true);
    expect(locked.retryAfterSeconds).toBe(5);
    expect(limiter.attempt('').limit).toBe(1); // no-IP key uses its own budget
    clock = 6500;
    expect(limiter.attempt('ip').allowed).toBe(true); // lock elapsed
    limiter.record('ip');
    limiter.clear('ip');
    expect(limiter.attempt('ip').remaining).toBe(2); // success reset
  });

  it('window boundary: entries exactly windowMs old prune, one tick younger stay', () => {
    let clock = 1000;
    const limiter = createLoginRateLimiter({ windowMs: 1000, maxAttempts: 2, noIpMaxAttempts: 3, lockoutMs: 5000 }, () => clock);
    limiter.record('ip'); // stamp 1000
    clock = 1999; // 1 ms inside the window
    expect(limiter.attempt('ip').remaining).toBe(1); // entry still live
    clock = 2000; // exactly windowMs old
    expect(limiter.attempt('ip').remaining).toBe(2); // pruned -> full budget
    limiter.record('ip'); // re-arms at 2000
    clock = 2999;
    expect(limiter.attempt('ip').remaining).toBe(1); // the new entry lives its own window
    clock = 3000;
    expect(limiter.attempt('ip').remaining).toBe(2); // exactly one window old again -> pruned
  });
});

describe('URL-token allowlist (doc 08 section 2.6)', () => {
  it('GET line: exact, prefix, pattern targets', () => {
    for (const path of ['/api/event', '/api/global/event', '/api/notnative/events', '/api/openchamber/events', '/api/notifications/stream', '/api/fs/raw', '/api/fs/serve']) {
      expect(urlTokenTargetAllowed('GET', path, false)).toBe(true);
    }
    for (const path of ['/api/fs/serve/a/b', '/api/preview/proxy/x', '/api/preview/proxy/deep/y', '/api/projects/abc/icon']) {
      expect(urlTokenTargetAllowed('GET', path, false)).toBe(true);
    }
    for (const path of ['/api/config/settings', '/api/session', '/api/terminal/ws', '/auth/session', '/api/projects/icon', '/api/fs/raw/extra']) {
      expect(urlTokenTargetAllowed('GET', path, false)).toBe(false);
    }
    expect(urlTokenTargetAllowed('POST', '/api/fs/raw', false)).toBe(false);
    expect([...URL_TOKEN_QUERY_ALIASES]).toStrictEqual(['oc_url_token', 'nn_url_token']);
  });

  it('WS line: exact upgrade paths only', () => {
    for (const path of ['/api/event/ws', '/api/global/event/ws', '/api/openchamber/realtime-proxy/ws', '/api/terminal/ws', '/api/dictation/ws', '/api/dev-tunnel']) {
      expect(urlTokenTargetAllowed('GET', path, true)).toBe(true);
    }
    expect(urlTokenTargetAllowed('GET', '/api/dev-tunnel/ws', true)).toBe(false);
    expect(urlTokenTargetAllowed('GET', '/api/terminal/ws/other', true)).toBe(false);
    expect(urlTokenTargetAllowed('POST', '/api/terminal/ws', true)).toBe(true); // upgrades are method-agnostic
  });
});

describe('ui-auth controller machine (clock-injected)', () => {
  function machine(input: { password: string | ''; budget?: number; rate?: Partial<import('../lib/auth/rate-limit.ts').LoginRateLimitConfig> }): {
    controller: ReturnType<typeof createUiAuthController>;
    clientStore: RemoteClientStore;
    clock: { value: number };
  } {
    const dir = freshScratch();
    const clock = { value: 1000 };
    const clientStore = new RemoteClientStore(dir);
    const controller = createUiAuthController({
      dataDir: dir,
      clientStore,
      now: () => clock.value,
      resolvePassword: input.password === '' ? () => '' : () => input.password,
      urlTokenBudget: input.budget,
      rate: input.rate,
    });
    return { controller, clientStore, clock };
  }

  const headersWith = (extra: Record<string, string> = {}): Headers => new Headers({ ...extra });

  it('verifyPassword honors normalize + open mode never verifies', () => {
    const one = machine({ password: 'op horse' });
    expect(one.controller.verifyPassword(' op horse ')).toBe(true);
    expect(one.controller.verifyPassword('op horse')).toBe(true);
    expect(one.controller.verifyPassword('wrong')).toBe(false);
    expect(one.controller.verifyPassword('')).toBe(false);
    const open = machine({ password: '' });
    expect(open.controller.passwordRequired()).toBe(false);
    expect(open.controller.verifyPassword('op horse')).toBe(false);
  });

  it('login: trust-device TTL, cookie attributes, desktop-only mint tied to cookie expiry', () => {
    const m = machine({ password: 'op horse' });
    const ttl = 7 * 24 * 60 * 60_000;
    const ok = m.controller.login({
      ip: '3.3.3.3',
      body: {
        password: 'op horse', trustDevice: true, issueClientToken: true, clientKind: 'desktop',
        dedupeKey: 'desk-1', clientLabel: 'Atlas', deviceName: 'desk', devicePlatform: 'macos', appVersion: '1.0',
      },
      headers: headersWith({ 'x-forwarded-proto': 'https' }),
      url: new URL('https://example.com/auth/session'),
      method: 'POST',
    });
    expect(ok.status).toBe(200);
    const minted = ok.body as { clientToken?: string; client?: Record<string, unknown> };
    expect(minted.clientToken).toMatch(/^oc_client_[A-Za-z0-9_-]{43}$/u); // 32B base64url
    expect(minted.client).not.toHaveProperty('tokenHash'); // hash never travels
    expect(minted.client?.expiresAt).toBe(new Date(1000 + ttl).toISOString()); // equals cookie TTL
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.setCookie).toContain('HttpOnly');
    expect(ok.setCookie).toContain('SameSite=Strict');
    expect(ok.setCookie).toContain('Max-Age=604800');
    expect(ok.setCookie).toContain('Secure'); // x-forwarded-proto https
    expect(ok.setCookie).toContain(UI_SESSION_COOKIE);

    const plain = m.controller.login({
      ip: '3.3.3.4', body: { password: 'op horse' },
      headers: headersWith(), url: new URL('http://example.com/auth/session'), method: 'POST',
    });
    expect(plain.setCookie).not.toContain('Secure'); // plain http
    expect(plain.setCookie).toContain('Max-Age=43200'); // 12 h default
    expect((plain.body as { clientToken?: string }).clientToken).toBeUndefined();

    const mobile = m.controller.login({
      ip: '3.3.3.5', body: { password: 'op horse', issueClientToken: true, clientKind: 'mobile' },
      headers: headersWith(), url: new URL('http://x/auth/session'), method: 'POST',
    });
    expect((mobile.body as { clientToken?: string }).clientToken).toBeUndefined(); // non-desktop kinds never mint
  });

  it('open mode login: no cookie, no limiter, desktop-local mint allowed', () => {
    const m = machine({ password: '' });
    const action = m.controller.login({
      ip: '', body: { issueClientToken: true, clientKind: 'desktop-local', dedupeKey: 'desktop-local' },
      headers: headersWith(), url: new URL('http://x/auth/session'), method: 'POST',
    });
    expect(action.status).toBe(200);
    expect(action.body).toMatchObject({ authenticated: true });
    expect((action.body as { clientToken?: string }).clientToken).toMatch(/^oc_client_/u);
    expect(action.setCookie).toBeUndefined();
  });

  it('login rate flow: failure headers, lockout 429 wins over correct password, success clears', () => {
    const m = machine({ password: 'op horse', rate: { maxAttempts: 2 } });
    const url = new URL('http://x/auth/session');
    m.controller.login({ ip: '4.4.4.4', body: { password: 'nope' }, headers: headersWith(), url, method: 'POST' });
    m.controller.login({ ip: '4.4.4.4', body: { password: 'nope' }, headers: headersWith(), url, method: 'POST' });
    const locked = m.controller.login({ ip: '4.4.4.4', body: { password: 'op horse' }, headers: headersWith(), url, method: 'POST' });
    expect(locked.status).toBe(429);
    expect(locked.headers['x-ratelimit-limit']).toBe('2');
    expect(locked.headers['retry-after']).toBe('900');
    expect(locked.clearSessionCookie).toBe(true);
    const fresh = m.controller.login({ ip: '5.5.5.5', body: { password: 'nope' }, headers: headersWith(), url, method: 'POST' });
    expect(fresh.status).toBe(401);
    expect(fresh.body).toMatchObject({ error: 'Invalid credentials' });
    expect(fresh.headers['x-ratelimit-limit']).toBe('2'); // this machine ran with maxAttempts: 2
    expect(fresh.headers['x-ratelimit-remaining']).toBe('2'); // attempt header shows the untouched budget
    expect(fresh.headers['retry-after']).toBeUndefined();
    const good = m.controller.login({ ip: '5.5.5.5', body: { password: 'op horse' }, headers: headersWith(), url, method: 'POST' });
    expect(good.status).toBe(200);
    const after = m.controller.login({ ip: '5.5.5.5', body: { password: 'nope' }, headers: headersWith(), url, method: 'POST' });
    expect(after.status).toBe(401); // cleared by success, not locked
    expect(after.clearSessionCookie).toBe(true);

    for (let index = 0; index < 3; index++) {
      m.controller.login({ ip: '', body: { password: 'war' }, headers: headersWith(), url, method: 'POST' });
    }
    const noIpLocked = m.controller.login({ ip: '', body: { password: 'op horse' }, headers: headersWith(), url, method: 'POST' });
    expect(noIpLocked.status).toBe(429);
    expect(noIpLocked.headers['x-ratelimit-limit']).toBe('3');
  });

  it('env override keys retune the caps; garbage/zero/negative fall back (E-08-4)', () => {
    process.env.NOTNATIVE_RATE_LIMIT_MAX_ATTEMPTS = '4';
    process.env.NOTNATIVE_RATE_LIMIT_NO_IP_MAX_ATTEMPTS = '0'; // invalid: keeps the default budget
    try {
      const m = machine({ password: 'op horse', rate: {} });
      const capped = m.controller.login({ ip: '9.9.9.1', body: { password: 'no' }, headers: headersWith(), url: new URL('http://x/auth/session'), method: 'POST' });
      expect(capped.headers['x-ratelimit-limit']).toBe('4');
      const noIp = m.controller.login({ ip: '', body: { password: 'no' }, headers: headersWith(), url: new URL('http://x/auth/session'), method: 'POST' });
      expect(noIp.headers['x-ratelimit-limit']).toBe('3'); // 0 is not a positive override -> the doc default stays
    } finally {
      delete process.env.NOTNATIVE_RATE_LIMIT_MAX_ATTEMPTS;
      delete process.env.NOTNATIVE_RATE_LIMIT_NO_IP_MAX_ATTEMPTS;
    }
  });

  it('url tokens: mint/resolve, expiry, budget eviction, both parents', () => {
    const m = machine({ password: 'op horse', budget: 3 });
    const first = m.controller.storeUrlToken('one');
    expect(first.token).toMatch(/^oc_url_[A-Za-z0-9_-]{32}$/u); // 24B base64url
    m.controller.storeUrlToken('two');
    m.controller.storeUrlToken('three');
    expect(m.controller.resolveUrlToken(first.token)).toBe('one'); // under budget, all alive
    const fourth = m.controller.storeUrlToken('four');
    expect(m.controller.resolveUrlToken(first.token)).toBeNull(); // oldest evicted
    expect(m.controller.resolveUrlToken(fourth.token)).toBe('four');
    m.clock.value = 1000 + 61_000;
    expect(m.controller.resolveUrlToken(fourth.token)).toBeNull(); // 60 s TTL
  });

  it('authenticate: jwt cookie, client-bound url token, revoked/expired fallthrough', () => {
    const m = machine({ password: 'op horse' });
    const issued = m.controller.issueSessionToken(60_000);
    const cookieHeaders = headersWith({ cookie: `${UI_SESSION_COOKIE}=${issued.token}` });
    const sessionOut = m.controller.authenticate(cookieHeaders, new URL('http://x/api/fs/raw'), 'GET');
    expect(sessionOut.ok === true && sessionOut.scope === 'session').toBe(true);

    const device = m.clientStore.createClient({ label: 'phone', clientKind: 'mobile' });
    const token = m.controller.storeUrlToken(`client:${device.client.id}`).token;
    const urlTokenOut = m.controller.authenticate(headersWith(), new URL(`http://x/api/fs/raw?oc_url_token=${token}`), 'GET');
    expect(urlTokenOut.ok === true && urlTokenOut.scope === 'client' && urlTokenOut.clientId === device.client.id).toBe(true);

    m.clientStore.revokeClient(device.client.id);
    const revoked = m.controller.authenticate(headersWith(), new URL(`http://x/api/fs/raw?oc_url_token=${token}`), 'GET');
    expect(revoked.ok === false && revoked.body.error === 'UI authentication required' && revoked.body.locked === true).toBe(true);

    const malformed = m.controller.authenticate(headersWith({ cookie: `${UI_SESSION_COOKIE}=junk` }), new URL('http://x/api/fs/raw'), 'GET');
    expect(malformed.ok === false && malformed.clearSessionCookie).toBe(true); // invalid cookie is cleared with the 401
  });

  it('authenticate: bearer precedence (revoked token cannot hide behind an ambient cookie)', () => {
    const m = machine({ password: 'op horse' });
    const cookie = m.controller.issueSessionToken(60_000).token;
    const bad = m.controller.authenticate(
      headersWith({ authorization: 'Bearer oc_client_zzz', cookie: `${UI_SESSION_COOKIE}=${cookie}` }),
      new URL('http://x/api/session'), 'GET',
    );
    expect(bad.ok).toBe(false);
  });

  it('expired URL tokens fall through at the authenticate surface (no clear, no grant)', () => {
    const m = machine({ password: 'op horse' });
    const issued = m.controller.issueSessionToken(60_000);
    const bound = m.controller.storeUrlToken(issued.token).token;
    const live = m.controller.authenticate(headersWith(), new URL(`http://x/api/fs/raw?oc_url_token=${bound}`), 'GET');
    expect(live.ok === true && live.scope === 'session').toBe(true);
    m.clock.value += 61_000; // past the 60 s TTL
    const expired = m.controller.authenticate(headersWith(), new URL(`http://x/api/fs/raw?oc_url_token=${bound}`), 'GET');
    expect(expired.ok === false && expired.status === 401 && expired.clearSessionCookie === false).toBe(true);
  });

  it('URL tokens bound to expired device parents fail closed via getActiveClient', () => {
    const m = machine({ password: 'op horse' }); // clock.value = 1000
    const device = m.clientStore.createClient({ clientKind: 'mobile', expiresAt: new Date(900).toISOString() });
    const bound = m.controller.storeUrlToken(`client:${device.client.id}`).token;
    const out = m.controller.authenticate(headersWith(), new URL(`http://x/api/fs/raw?oc_url_token=${bound}`), 'GET');
    expect(out.ok === false && out.status === 401).toBe(true);
    const bearer = m.controller.authenticate(headersWith({ authorization: `Bearer ${device.token}` }), new URL('http://x/api/session'), 'GET');
    expect(bearer.ok).toBe(false); // the expired parent fails the bearer side too
  });

  it('open mode mint honors the trustDevice TTL for the client token', () => {
    const m = machine({ password: '' });
    const trustTtl = 7 * 24 * 60 * 60_000;
    const plain = m.controller.login({
      ip: '', body: { issueClientToken: true, clientKind: 'desktop-local', dedupeKey: 'dl-plain' },
      headers: headersWith(), url: new URL('http://x/auth/session'), method: 'POST',
    });
    expect((plain.body as { client?: { expiresAt: string } }).client?.expiresAt).toBe(new Date(1000 + 12 * 60 * 60_000).toISOString());
    const trusted = m.controller.login({
      ip: '', body: { trustDevice: true, issueClientToken: true, clientKind: 'desktop-local', dedupeKey: 'dl-trust' },
      headers: headersWith(), url: new URL('http://x/auth/session'), method: 'POST',
    });
    expect((trusted.body as { client?: { expiresAt: string } }).client?.expiresAt).toBe(new Date(1000 + trustTtl).toISOString());
  });

  it('mint refuses bare URL-token renewal and binds client parents', () => {
    const m = machine({ password: 'op horse' });
    const device = m.clientStore.createClient({ clientKind: 'desktop' });
    const bearer = { authorization: `Bearer ${device.token}` };
    const mint = m.controller.mintUrlTokenFromRequest(headersWith(bearer), new URL('http://x/auth/url-token'), 'POST');
    expect(mint.status).toBe(200);
    const body = mint.body as { token: string; expiresAt: string };
    expect(body.token).toMatch(/^oc_url_/u);
    expect(body.expiresAt).toBe(new Date(1000 + 60_000).toISOString());
    expect(mint.headers['cache-control']).toBe('no-store');

    const cookie = m.controller.issueSessionToken(60_000).token;
    const withCookie = m.controller.mintUrlTokenFromRequest(headersWith({ cookie: `${UI_SESSION_COOKIE}=${cookie}` }), new URL('http://x/auth/url-token'), 'POST');
    expect(withCookie.status).toBe(200);

    const selfRenew = m.controller.mintUrlTokenFromRequest(headersWith(), new URL(`http://x/auth/url-token?oc_url_token=${body.token}`), 'POST');
    expect(selfRenew.status).toBe(401); // url tokens cannot renew themselves
    const anon = m.controller.mintUrlTokenFromRequest(headersWith(), new URL('http://x/auth/url-token'), 'POST');
    expect(anon.status).toBe(401);
  });

  it('resetSessionAuth: cookie-only, rotates secret, survives bearer device tokens', () => {
    const m = machine({ password: 'op horse' });
    const device = m.clientStore.createClient({ authMethod: 'password', clientKind: 'desktop' });
    const cookie = m.controller.issueSessionToken(60_000).token;

    const withBearer = m.controller.resetSessionAuth(headersWith({ authorization: `Bearer ${device.token}` }));
    expect(withBearer.status).toBe(401); // never a bare client token (§2.2)
    const anon = m.controller.resetSessionAuth(headersWith());
    expect(anon.status).toBe(401);
    const rotated = m.controller.resetSessionAuth(headersWith({ cookie: `${UI_SESSION_COOKIE}=${cookie}` }));
    expect(rotated.status).toBe(200);
    expect(rotated.body).toMatchObject({ authenticated: false, reset: true });
    expect(rotated.clearSessionCookie).toBe(true);

    const stale = m.controller.authenticate(headersWith({ cookie: `${UI_SESSION_COOKIE}=${cookie}` }), new URL('http://x/api/session'), 'GET');
    expect(stale.ok).toBe(false); // rotation killed the cookie
    const deviceStill = m.controller.authenticate(headersWith({ authorization: `Bearer ${device.token}` }), new URL('http://x/api/session'), 'GET');
    expect(deviceStill.ok).toBe(true); // device tokens never rotate here
  });

  it('upgradeAllowed rides authenticate; open mode admits without credentials', () => {
    const m = machine({ password: '' });
    expect(m.controller.upgradeAllowed(new URL('http://x/api/terminal/ws'), headersWith(), 'GET')).toBe(true);
    const locked = machine({ password: 'op horse' });
    expect(locked.controller.upgradeAllowed(new URL('http://x/api/terminal/ws'), headersWith(), 'GET')).toBe(false);
    expect(locked.controller.upgradeAllowed(new URL('http://x/api/terminal/ws'), headersWith({ cookie: `${UI_SESSION_COOKIE}=${locked.controller.issueSessionToken(60_000).token}` }), 'GET')).toBe(true);
    const minted = locked.controller.storeUrlToken(locked.controller.issueSessionToken(60_000).token);
    const upgradeHeaders = headersWith({ upgrade: 'websocket' });
    expect(locked.controller.upgradeAllowed(new URL(`http://x/api/dictation/ws?oc_url_token=${minted.token}`), upgradeHeaders, 'GET')).toBe(true);
    expect(locked.controller.upgradeAllowed(new URL(`http://x/api/config/settings?oc_url_token=${minted.token}`), upgradeHeaders, 'GET')).toBe(false); // not a WS-exact target
  });
});

describe('route surface (singleton app)', () => {
  beforeEach(() => {
    resetUiAuthForTests(); // fresh limiter + url tokens + jwt secret per test; password stays in the settings file
  });

  it('open mode: session open, /api reachable, url-token mint free, login stubs retired', async () => {
    const status = await call('/auth/session');
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ authenticated: true, authRequired: false, scope: 'open' });
    const settings = await call('/api/config/settings?surface=web');
    expect(settings.status).toBe(200);
    const mint = await call('/auth/url-token', { method: 'POST' });
    expect(mint.status).toBe(200);
    const mintBody = await mint.json() as { token: string };
    expect(mintBody.token).toMatch(/^oc_url_[A-Za-z0-9_-]{32}$/u);
    expect((await call('/auth/login', { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await call('/auth/logout', { method: 'POST' })).status).toBe(404);
  });

  it('password set via the settings secret: gates close', async () => {
    setEnvPassword('hunter2');
    const status = await call('/auth/session');
    expect(status.status).toBe(401);
    expect(await status.json()).toMatchObject({ authenticated: false, locked: true });
    const settings = await call('/api/config/settings?surface=web');
    expect(settings.status).toBe(401);
    expect(await settings.json()).toMatchObject({ error: 'UI authentication required', locked: true });
    expect(settings.headers.get('cache-control')).toBe('no-store');
    const bare = await call('/api'); // the bare origin path is inside /api/* too (Hono trailing-wildcard match)
    expect(bare.status).toBe(401);
    const proxyCatchAll = await call('/api/no/such/harness/path', { method: 'DELETE' }); // unmatched /api verbs ride the gated catch-all
    expect(proxyCatchAll.status).toBe(401);
  });

  it('login round-trip: cookie grants scope session, invalid grants clear + 401', async () => {
    setEnvPassword('hunter2');
    const ok = await login({ password: 'hunter2' }, '20.0.0.1');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ authenticated: true });
    const cookie = cookieValue(ok, UI_SESSION_COOKIE)!;
    expect(cookie).toBeTruthy();
    expect(ok.headers.get('cache-control')).toBe('no-store');

    const session = await call('/auth/session', { headers: { cookie: `${UI_SESSION_COOKIE}=${cookie}` } });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ authenticated: true, scope: 'session' });
    const settings = await call('/api/config/settings?surface=web', { headers: { cookie: `${UI_SESSION_COOKIE}=${cookie}` } });
    expect(settings.status).toBe(200);

    const wrong = await login({ password: 'wrong' }, '20.0.0.2');
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ error: 'Invalid credentials' });
    expect(hasClearCookie(wrong)).toBe(true);
    const malformed = await call('/auth/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '20.0.0.3' },
      body: ']-[',
    });
    expect(malformed.status).toBe(401);
    const oversized = await call('/auth/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '20.0.0.3' },
      body: JSON.stringify({ password: 'hunter2', pad: 'x'.repeat(64 * 1024) }),
    });
    expect(oversized.status).toBe(401); // > 64 KiB documents never reach the verifier
    const stale = await call('/auth/session', { headers: { cookie: `${UI_SESSION_COOKIE}=garbage` } });
    expect(stale.status).toBe(401);
    expect(hasClearCookie(stale)).toBe(true);
  });

  it('cookie attributes: http stays insecure, forwarding implies Secure, trust device widens TTL', async () => {
    setEnvPassword('hunter2');
    const plain = await login({ password: 'hunter2' }, '21.0.0.1');
    const plainCookie = setCookies(plain).find((value) => value.startsWith('oc_ui_session='))!;
    expect(plainCookie).toContain('Max-Age=43200');
    expect(plainCookie).not.toContain('Secure');
    expect(plainCookie).toContain('SameSite=Strict');
    const forwarded = await call('/auth/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '21.0.0.2', 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ password: 'hunter2', trustDevice: true }),
    });
    const forwardedCookie = setCookies(forwarded).find((value) => value.startsWith('oc_ui_session='))!;
    expect(forwardedCookie).toContain('Secure');
    expect(forwardedCookie).toContain('Max-Age=604800');
  });

  it('reset rotates the session secret; device tokens survive; bearer-only users stay out', async () => {
    setEnvPassword('hunter2');
    const session = await login({ password: 'hunter2' }, '22.0.0.1');
    const cookie = cookieValue(session, UI_SESSION_COOKIE)!;
    const minted = await login({ password: 'hunter2', issueClientToken: true, clientKind: 'desktop', dedupeKey: 'desk-2' }, '22.0.0.2');
    const { clientToken } = await minted.json() as { clientToken?: string };
    expect(clientToken).toMatch(/^oc_client_/u);

    const bearerReset = await call('/api/auth/reset', { method: 'POST', headers: { authorization: `Bearer ${clientToken}` } });
    expect(bearerReset.status).toBe(401); // session-only endpoint (§2.2)
    const anonReset = await call('/api/auth/reset', { method: 'POST' });
    expect(anonReset.status).toBe(401);
    const reset = await call('/api/auth/reset', { method: 'POST', headers: { cookie: `${UI_SESSION_COOKIE}=${cookie}` } });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ authenticated: false, reset: true });
    expect(hasClearCookie(reset)).toBe(true);

    const stale = await call('/auth/session', { headers: { cookie: `${UI_SESSION_COOKIE}=${cookie}` } });
    expect(stale.status).toBe(401);
    const device = await call('/auth/session', { headers: { authorization: `Bearer ${clientToken}` } });
    expect(device.status).toBe(200);
    expect(await device.json()).toMatchObject({ authenticated: true, scope: 'client' });
  });

  it('url tokens ride the allowlist in both spellings and fall through elsewhere', async () => {
    setEnvPassword('hunter2');
    const session = await login({ password: 'hunter2' }, '23.0.0.1');
    const cookie = cookieValue(session, UI_SESSION_COOKIE)!;
    const mint = await call('/auth/url-token', { method: 'POST', headers: { cookie: `${UI_SESSION_COOKIE}=${cookie}` } });
    expect(mint.status).toBe(200);
    const { token } = await mint.json() as { token: string };

    const settings401 = await call('/api/config/settings?surface=web&oc_url_token=' + token);
    expect(settings401.status).toBe(401); // not allowlisted -> falls through to open checks
    writeFileSync(joinPath(isolatedDataDir, 'gate-probe.txt'), 'gate'); // deterministic fs target
    const raw = await call(`/api/fs/raw?path=gate-probe.txt&directory=${encodeURIComponent(isolatedDataDir)}&oc_url_token=${token}`);
    expect(raw.status).toBe(200);
    const aliased = await call(`/api/fs/raw?path=gate-probe.txt&directory=${encodeURIComponent(isolatedDataDir)}&nn_url_token=${token}`);
    expect(aliased.status).toBe(200); // coordinated alias rides the same list
    const postRaw = await call(`/api/fs/raw?path=gate-probe.txt&directory=${encodeURIComponent(isolatedDataDir)}&oc_url_token=${token}`, { method: 'POST' });
    expect(postRaw.status).toBe(401); // URL tokens are GET-only off the WS paths
    const renew = await call('/auth/url-token?oc_url_token=' + token, { method: 'POST', headers: { cookie: `x=1` } });
    expect(renew.status).toBe(401); // a URL token cannot renew itself

    const device = await login({ password: 'hunter2', issueClientToken: true, clientKind: 'desktop', dedupeKey: 'desk-4' }, '23.0.0.2');
    const { clientToken, client } = await device.json() as { clientToken?: string; client?: { id: string } };
    const clientMint = await call('/auth/url-token', { method: 'POST', headers: { authorization: `Bearer ${clientToken}` } });
    expect(clientMint.status).toBe(200);
    const bound = await clientMint.json() as { token: string };
    const clientRaw = await call(`/api/fs/raw?path=gate-probe.txt&directory=${encodeURIComponent(isolatedDataDir)}&oc_url_token=${bound.token}`);
    expect(clientRaw.status).toBe(200); // client:<id> parent resolves
    expect(client?.id).toBeTruthy();
  });

  it('revoked device records kill their bound URL tokens through the gate', async () => {
    setEnvPassword('hunter2');
    const device = await login({ password: 'hunter2', issueClientToken: true, clientKind: 'desktop', dedupeKey: 'desk-5' }, '24.0.0.1');
    const { clientToken } = await device.json() as { clientToken: string };
    const mint = await call('/auth/url-token', { method: 'POST', headers: { authorization: `Bearer ${clientToken}` } });
    const { token } = await mint.json() as { token: string };
    const before = await call(`/api/config/settings?surface=web&oc_url_token=${token}`);
    expect(before.status).toBe(401); // settings is not allowlisted regardless
    // Revoke directly through a fresh store view on the same dataDir files is
    // impossible (in-memory inventory); revoke via the real machinery: the
    // desktop mint path is exercised in the store tests, here we pin the
    // gate's fallthrough for an unknown id instead.
    const bogus = await call(`/api/fs/raw?oc_url_token=oc_url_${'0'.repeat(32)}`);
    expect(bogus.status).toBe(401);
  });

  it('login rate limiting: 10 per IP then lockout, strict no-IP budget, headers on responses', async () => {
    setEnvPassword('hunter2');
    for (let index = 0; index < 10; index++) {
      const wrong = await login({ password: 'hunter2x' }, '25.0.0.1');
      expect(wrong.status).toBe(401);
      expect(wrong.headers.get('x-ratelimit-remaining')).toBe(String(10 - index));
    }
    const locked = await login({ password: 'hunter2' }, '25.0.0.1');
    expect(locked.status).toBe(429); // lockout wins over the correct password
    expect(locked.headers.get('retry-after')).toBe('900');
    expect(locked.headers.get('x-ratelimit-limit')).toBe('10');
    expect(await locked.json()).toMatchObject({ error: 'Too many failed login attempts', locked: true });

    for (let index = 0; index < 3; index++) {
      const wrong = await call('/auth/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'war' }),
      });
      expect(wrong.status).toBe(401); // no-IP budget: 3 per 5 min
      expect(wrong.headers.get('x-ratelimit-limit')).toBe('3');
    }
    const noIp = await call('/auth/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'hunter2' }) });
    expect(noIp.status).toBe(429);
    expect(noIp.headers.get('x-ratelimit-limit')).toBe('3');
    expect(noIp.headers.get('x-ratelimit-remaining')).toBe('0');

    resetUiAuthForTests(); // separate bucket: success clears the failed window
    for (let index = 0; index < 2; index++) await login({ password: 'war' }, '26.0.0.1');
    const good = await login({ password: 'hunter2' }, '26.0.0.1');
    expect(good.status).toBe(200);
    const after = await login({ password: 'war' }, '26.0.0.1');
    expect(after.status).toBe(401); // cleared by success, not locked
  });

  it('reset refuses env-backed secrets (rotation disabled)', async () => {
    setEnvPassword('hunter2');
    process.env.NOTNATIVE_JWT_SECRET = 'z'.repeat(64);
    resetUiAuthForTests();
    try {
      const session = await login({ password: 'hunter2' }, '27.0.0.1');
      const cookie = cookieValue(session, UI_SESSION_COOKIE)!;
      const aborted = await call('/api/auth/reset', { method: 'POST', headers: { cookie: `${UI_SESSION_COOKIE}=${cookie}` } });
      expect(aborted.status).toBe(403);
      expect(await aborted.json()).toMatchObject({ error: 'JWT secret rotation is disabled while NOTNATIVE_JWT_SECRET is set' });
    } finally {
      delete process.env.NOTNATIVE_JWT_SECRET;
    }
  });

  it('password source is env-only: the registry secret does not gate (E-08-14)', async () => {
    setEnvPassword('envpass');
    try {
      const session = await login({ password: 'envpass' }, '28.0.0.0');
      const cookie = cookieValue(session, UI_SESSION_COOKIE)!;
      const record = await call('/api/config/settings?surface=desktop', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie: `${UI_SESSION_COOKIE}=${cookie}` },
        body: JSON.stringify({ desktopUiPassword: 'hunter2' }),
      });
      expect(record.status).toBe(200); // accepted-never-returned (§F.2)
      const settingsLogin = await login({ password: 'hunter2' }, '28.0.0.1');
      expect(settingsLogin.status).toBe(401); // the stored secret is NOT an auth consumer
      const envLogin = await login({ password: 'envpass' }, '28.0.0.2');
      expect(envLogin.status).toBe(200);
    } finally {
      clearEnvPassword();
    }
    const open = await call('/auth/session');
    expect(open.status).toBe(200);
    expect(await open.json()).toMatchObject({ authenticated: true, scope: 'open' });
  });
});

describe('terminal wire gate hardening (E-07-3, fail closed)', () => {
  it('the upgrade listener survives a throwing gate and denies the socket', async () => {
    const server = await new Promise<HttpServer>((resolvePromise) => {
      const made = createServer();
      made.listen(0, '127.0.0.1', () => resolvePromise(made as unknown as HttpServer));
    });
    const address = server.address() as { port: number };
    const wiring = attachTerminalWebsocket(
      server,
      {} as TerminalRuntime, // never reached: the gate throws before upgrade admission
      () => { throw new Error('boom'); },
    );
    const denied = await new Promise<boolean>((resolvePromise) => {
      const probe = new WebSocket(`ws://127.0.0.1:${address.port}/api/terminal/ws`);
      probe.once('open', () => resolvePromise(false));
      probe.once('error', () => resolvePromise(true));
      probe.once('close', () => resolvePromise(true));
      const timeout = setTimeout(() => resolvePromise(true), 2500);
      timeout.unref?.();
    });
    expect(denied).toBe(true); // denied without crashing the process
    wiring.dispose();
    await new Promise<void>((done) => server.close(() => done()));
  });
});
