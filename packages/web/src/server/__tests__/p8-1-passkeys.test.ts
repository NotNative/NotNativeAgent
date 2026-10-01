// SPDX-License-Identifier: Apache-2.0
/**
 * P8-1 step 5 gates (doc 08 section 2.4 + E-08-3): disabled-unless-password
 * posture, HMAC password binding with change/rotation clears, per-rpID
 * scoping, 5-minute one-shot challenge records, registration
 * (session-cookie-only; excludeCredentials), authentication (anonymous over
 * the login rate limit; trust-device honored; counter bumps), revoke by id
 * AND rpID, the tunnel-scope 403 family, and the auth-reset passkey purge.
 * Route-level happy paths are covered at the machine level with an
 * injected ceremony adapter; the route suite pins the guards against the
 * real @simplewebauthn adapter AND drives the full registration +
 * authentication lifecycle through the app with a synthetic P-256
 * authenticator (server-built CBOR/COSE fixtures), which is what pins the
 * expected-origin port parity (browser clientDataJSON origins carry the
 * port; the compare is an exact string match) and the grantedLogin
 * Set-Cookie on the authenticate/verify route.
 */
import { BOOT_DATA_DIR } from './helpers/env-boot.ts';
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath, sep } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as settingsStore from '../lib/settings-store.ts';
import { ENV } from '../env.ts';
import { resetUiAuthForTests, getUiAuthController, UI_SESSION_COOKIE } from '../lib/auth/ui-auth.ts';
import { createUiPasskeysController, resetPasskeysForTests, getUiPasskeysController, PASSKEYS_DISABLED_TEXT, type UiPasskeysController } from '../lib/auth/ui-passkeys.ts';
import { deriveRpContext, isLocalRpId, normalizedRpId } from '../lib/auth/rp-context.ts';
import type { CeremonyAdapter } from '../lib/auth/webauthn-ceremony.ts';
import { resetTunnelAuthForTests, getTunnelAuthController, TUNNEL_COOKIE_NAME } from '../lib/auth/tunnel-auth.ts';
import { registerHarnessAdapter } from '../harness/adapter.ts';
import { mockHarness } from '../harness/mock/index.ts';

const isolatedDataDir = BOOT_DATA_DIR;
process.env.NOTNATIVE_DATA_DIR = isolatedDataDir;
delete process.env.NOTNATIVE_UI_PASSWORD;
const scratchDirs: string[] = [];
const origin = 'http://localhost';

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

function setCookies(response: Response): string[] {
  const accessor = (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  return typeof accessor === 'function' ? accessor.call(response.headers) : [];
}

function setEnvPassword(value: string): void {
  process.env.NOTNATIVE_UI_PASSWORD = value;
  resetUiAuthForTests();
  resetPasskeysForTests();
}

function freshScratch(): string {
  const made = mkdtempSync(`${tmpdir()}${sep}nnd-p8p-`);
  scratchDirs.push(made);
  return made;
}

function clearEnvPassword(): void {
  delete process.env.NOTNATIVE_UI_PASSWORD;
  resetUiAuthForTests();
  resetPasskeysForTests();
}

async function call(path: string, init?: RequestInit, env?: unknown): Promise<Response> {
  const request = new Request(`${origin}${path}`, init);
  return (appInstance as App).fetch(request, env ?? { incoming: { socket: { remoteAddress: '127.0.0.1' } } });
}

function callAt(path: string, hostOrigin: string, init?: RequestInit, env?: unknown): Promise<Response> {
  const request = new Request(`${hostOrigin}${path}`, init);
  return (appInstance as App).fetch(request, env ?? { incoming: { socket: { remoteAddress: '127.0.0.1' } } });
}

async function loginForCookie(ip = '30.0.0.1'): Promise<string> {
  const login = await call('/auth/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ password: 'hunter2' }),
  });
  expect(login.status).toBe(200);
  const cookie = setCookies(login).find((value) => value.startsWith(UI_SESSION_COOKIE)) ?? '';
  return cookie.split(';')[0] ?? '';
}

interface FakeEvent {
  lastOptions: { rpID: string; userID: Uint8Array; excludeCredentials: { id: string; transports?: string[] }[] } | null;
  lastAuthOptions: { rpID: string; allowCredentials: { id: string; transports?: string[] }[] } | null;
  lastRegister: { expectedChallenge: string; expectedRPID: string; expectedOrigin: string[] } | null;
  lastAuth: { expectedChallenge: string; expectedRPID: string; credentialId: string; counter: number } | null;
}

function fakeCeremony(failVerify = false): CeremonyAdapter & FakeEvent {
  let sequence = 0;
  const event: FakeEvent = { lastOptions: null, lastAuthOptions: null, lastRegister: null, lastAuth: null };
  const adapter: CeremonyAdapter & FakeEvent = {
    ...event,
    async registrationOptions(input) {
      adapter.lastOptions = { rpID: input.rpID, userID: input.userID, excludeCredentials: input.excludeCredentials };
      sequence += 1;
      return {
        rpID: input.rpID, rpName: input.rpName, userName: input.userName, userID: Buffer.from(input.userID).toString('base64url'),
        challenge: `reg-chal-${sequence}`,
        excludeCredentials: input.excludeCredentials,
        authenticatorSelection: input.authenticatorSelection,
        attestationType: 'none',
        pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
      };
    },
    async verifyRegistration(input) {
      adapter.lastRegister = { expectedChallenge: input.expectedChallenge, expectedRPID: input.expectedRPID, expectedOrigin: [...input.expectedOrigin] };
      if (failVerify) return { verified: false };
      return {
        verified: true,
        registrationInfo: {
          credential: { id: input.response.id, publicKey: new Uint8Array([7, 8, 9, 10]), counter: 0, transports: ['internal'] },
          credentialDeviceType: 'singleDevice',
          credentialBackedUp: false,
        },
      };
    },
    async authenticationOptions(input) {
      adapter.lastAuthOptions = { rpID: input.rpID, allowCredentials: input.allowCredentials };
      sequence += 1;
      return { rpID: input.rpID, challenge: `auth-chal-${sequence}`, allowCredentials: input.allowCredentials, userVerification: 'required' };
    },
    async verifyAuthentication(input) {
      adapter.lastAuth = { expectedChallenge: input.expectedChallenge, expectedRPID: input.expectedRPID, credentialId: input.credential.id, counter: input.credential.counter };
      if (failVerify) return { verified: false };
      return { verified: true, authenticationInfo: { newCounter: input.credential.counter + 1, userVerified: true } };
    },
  };
  return adapter;
}

const REG_RESPONSE = {
  id: 'cred-1', rawId: 'cred-1', type: 'public-key',
  response: { clientDataJSON: 'c', attestationObject: 'a' },
};
const AUTH_RESPONSE = {
  id: 'cred-1', rawId: 'cred-1', type: 'public-key',
  response: { clientDataJSON: 'c', authenticatorData: 'a', signature: 's' },
};

function storePasskey(dir: string, input: { now?: () => number; ceremony?: CeremonyAdapter; password?: string }): UiPasskeysController {
  if (input.password !== undefined) process.env.NOTNATIVE_UI_PASSWORD = input.password;
  resetUiAuthForTests();
  const pk = createUiPasskeysController({
    dataDir: dir,
    uiAuth: getUiAuthController(),
    ceremony: input.ceremony ?? fakeCeremony(),
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  return pk;
}

async function registerOne(pk: UiPasskeysController, headers: Headers, url: URL, label?: string): Promise<void> {
  const options = await pk.registerOptions(headers, url);
  expect(options.status).toBe(200);
  const body = options.body as { requestId: string };
  const verify = await pk.registerVerify(headers, url, {
    requestId: body.requestId,
    ...(label !== undefined ? { label } : {}),
    response: REG_RESPONSE,
  });
  expect(verify.status).toBe(200);
}

describe('rp derivation (doc 08 section 2.4)', () => {
  it('x-forwarded-host wins; normalization strips brackets/ports; local rp set; URL fallback', () => {
    expect(ENV.dataDir).toBe(isolatedDataDir);
    const rp = deriveRpContext(
      new Headers({ 'x-forwarded-host': 'vpn.example.com, inner.local', 'host': 'localhost:3902' }),
      new URL('http://localhost:3902/auth/x'),
    );
    expect(rp.rpID).toBe('vpn.example.com');
    expect(rp.expectedOrigins).toStrictEqual(['http://vpn.example.com']);
    expect(deriveRpContext(new Headers({ host: '[::1]:5180' }), new URL('http://localhost/x')).rpID).toBe('::1');
    expect(deriveRpContext(new Headers({ 'x-forwarded-proto': 'https', host: 'x.com' }), new URL('https://x.com/y')).expectedOrigins[0]).toBe('https://x.com');
    expect(normalizedRpId('Pocket.Example.COM:8443')).toBe('pocket.example.com');
    expect(isLocalRpId('localhost') && isLocalRpId('127.0.0.1') && isLocalRpId('::1')).toBe(true);
    expect(deriveRpContext(new Headers(), new URL('https://only.url/base')).rpID).toBe('only.url');
  });

  it('expected origin keeps the browser-visible port (exact clientDataJSON parity) and re-brackets IPv6', () => {
    // WebAuthn clientDataJSON.origins carry the port when it is not the
    // scheme default; @simplewebauthn v14 compares it as an exact string.
    const forwarded = deriveRpContext(
      new Headers({ 'x-forwarded-host': 'vpn.example.com:8443', 'x-forwarded-proto': 'https' }),
      new URL('http://127.0.0.1:3902/auth/x'),
    );
    expect(forwarded.rpID).toBe('vpn.example.com'); // rpID MUST drop the port
    expect(forwarded.expectedOrigins).toStrictEqual(['https://vpn.example.com:8443']);

    expect(deriveRpContext(new Headers({ host: 'localhost:3902' }), new URL('http://localhost:3902/x')).expectedOrigins)
      .toStrictEqual(['http://localhost:3902']);
    expect(deriveRpContext(new Headers(), new URL('http://[::1]:5180/x')).expectedOrigins)
      .toStrictEqual(['http://[::1]:5180']);
    expect(deriveRpContext(new Headers({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'x.com:443' }), new URL('http://127.0.0.1:3902/x')).expectedOrigins)
      .toStrictEqual(['https://x.com']); // scheme-default 443 is dropped by browsers
    expect(deriveRpContext(new Headers({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'x.com:80' }), new URL('http://127.0.0.1:3902/x')).expectedOrigins)
      .toStrictEqual(['https://x.com:80']);
  });
});

describe('passkey machine (clock-injected, ceremony-injected)', () => {
  it('disabled unless a password exists; every call answers 400 with the exact text', async () => {
    const ceremony = fakeCeremony();
    const pk = storePasskey(freshScratch(), { ceremony, password: '' });
    expect(pk.hasPassword()).toBe(false);
    expect((await pk.registerOptions(new Headers(), new URL('http://localhost/x'))).body).toMatchObject({ error: PASSKEYS_DISABLED_TEXT });
    expect((await pk.authenticationOptions(new Headers(), new URL('http://localhost/x'))).body).toMatchObject({ error: PASSKEYS_DISABLED_TEXT });
    expect((await pk.authenticateVerify(new Headers(), new URL('http://localhost/x'), {}, '')).body).toMatchObject({ error: PASSKEYS_DISABLED_TEXT });
    expect(pk.revoke('id', new Headers(), new URL('http://localhost/x')).body).toMatchObject({ error: PASSKEYS_DISABLED_TEXT });
  });

  it('binding guards: password change clears on reload; secret rotation clears; rewrite is atomic', async () => {
    const dir = freshScratch();
    const ceremony = fakeCeremony();
    const live = storePasskey(dir, { ceremony, password: 'hunter2', now: () => 1000 });
    await registerOne(live, new Headers({ host: 'localhost' }), new URL('http://localhost/x'));
    expect((live.listFor(new Headers({ host: 'localhost' }), new URL('http://localhost/x')).body as { passkeys: unknown[] }).passkeys).toHaveLength(1);
    expect(readFileSync(joinPath(dir, 'ui-passkeys.json'), 'utf8')).toContain('"passkeys": [');

    process.env.NOTNATIVE_UI_PASSWORD = 'new-pass';
    resetUiAuthForTests();
    const reloaded = createUiPasskeysController({ dataDir: dir, uiAuth: getUiAuthController(), ceremony: fakeCeremony(), now: () => 2000 });
    expect((reloaded.listFor(new Headers({ host: 'localhost' }), new URL('http://localhost/x')).body as { passkeys: unknown[] }).passkeys).toHaveLength(0);
    expect(readFileSync(joinPath(dir, 'ui-passkeys.json'), 'utf8')).toContain('"passkeys": []');

    // same password, rotated secret -> cleared again (rotate the secret FILE;
    // a reset() via the ui singleton alone reuses the file-backed secret)
    await registerOne(reloaded, new Headers({ host: 'localhost' }), new URL('http://localhost/x'));
    writeFileSync(joinPath(isolatedDataDir, 'jwt-secret'), 'f'.repeat(64));
    resetUiAuthForTests(); // fresh holder re-reads the new file
    const rotated = createUiPasskeysController({ dataDir: dir, uiAuth: getUiAuthController(), ceremony: fakeCeremony(), now: () => 3000 });
    expect((rotated.listFor(new Headers({ host: 'localhost' }), new URL('http://localhost/x')).body as { passkeys: unknown[] }).passkeys).toHaveLength(0);
    delete process.env.NOTNATIVE_UI_PASSWORD;
    resetUiAuthForTests();
  });

  it('registration: ceremony args, challenge pinning, one-shot requestId, stored record shape, scoping', async () => {
    const dir = freshScratch();
    let clock = 1000;
    const ceremony = fakeCeremony();
    const pk = storePasskey(dir, { ceremony, password: 'hunter2', now: () => clock });
    const headers = new Headers({ host: 'localhost' });
    const url = new URL('http://localhost/x');

    const options = await pk.registerOptions(headers, url);
    const optionsBody = options.body as { requestId: string; challenge: string; rpID: string; attestationType: string; authenticatorSelection: { residentKey: string; userVerification: string } };
    expect(optionsBody.rpID).toBe('localhost');
    expect(optionsBody.attestationType).toBe('none');
    expect(optionsBody.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
    expect(ceremony.lastOptions?.userID.byteLength).toBe(32);
    expect(optionsBody.requestId).toMatch(/^[A-Za-z0-9_-]{22}$/u);

    expect((await pk.registerVerify(headers, url, { requestId: 'gone', response: REG_RESPONSE })).status).toBe(400);
    expect((await pk.registerVerify(headers, url, { requestId: optionsBody.requestId, response: { id: 'x' } })).status).toBe(400);
    const reoptions = await pk.registerOptions(headers, url); // challenge records are reusable for NEW options only
    expect(reoptions.body).toMatchObject({ challenge: expect.anything() });
    clock += 5 * 60_000;
    const expired = await pk.registerVerify(headers, url, { requestId: optionsBody.requestId, response: REG_RESPONSE });
    expect(expired.status).toBe(400); // 5-minute TTL
    clock = 1000;

    const fresh = await pk.registerOptions(headers, url);
    const freshBody = fresh.body as { requestId: string; challenge: string };
    const ok = await pk.registerVerify(headers, url, { requestId: freshBody.requestId, label: 'Atlas desk', response: REG_RESPONSE });
    expect(ok.status).toBe(200);
    expect(ceremony.lastRegister).toEqual({
      expectedChallenge: freshBody.challenge,
      expectedRPID: 'localhost',
      expectedOrigin: ['http://localhost'],
    });
    const stored = (pk.listFor(headers, url).body as { passkeys: { id: string; publicKey: string; counter: number; label: string; deviceType: string; backedUp: boolean; rpID: string; transports?: string[] }[] }).passkeys[0]!;
    expect(stored).toMatchObject({ id: 'cred-1', publicKey: 'BwgJCg', counter: 0, label: 'Atlas desk', deviceType: 'singleDevice', backedUp: false, rpID: 'localhost', transports: ['internal'] });

    const next = await pk.registerOptions(headers, url);
    expect((next.body as { excludeCredentials: { id: string; transports?: string[] }[] }).excludeCredentials).toStrictEqual([{ id: 'cred-1', transports: ['internal'] }]);
    expect((pk.listFor(new Headers({ host: 'vpn.example.com' }), new URL('https://vpn.example.com/x')).body as { passkeys: unknown[] }).passkeys).toHaveLength(0);
    delete process.env.NOTNATIVE_UI_PASSWORD;
    resetUiAuthForTests();
  });

  it('authentication: anonymous options, grant rides trust-device, counter bumps, replay fails, foreign rp excludes', async () => {
    const dir = freshScratch();
    let clock = 1000;
    const ceremony = fakeCeremony();
    const pk = storePasskey(dir, { ceremony, password: 'hunter2', now: () => clock });
    const headers = new Headers({ host: 'localhost' });
    const url = new URL('http://localhost/x');
    await registerOne(pk, headers, url);

    const options = await pk.authenticationOptions(headers, url);
    const optionsBody = options.body as { requestId: string; challenge: string };
    expect(ceremony.lastAuthOptions?.allowCredentials.map((entry) => entry.id)).toStrictEqual(['cred-1']);
    expect(((await pk.authenticationOptions(new Headers({ host: 'vpn.example.com' }), new URL('https://vpn.example.com/x'))).body as { error?: string }).error).toBe('No passkeys registered for this origin');

    const failId = await pk.authenticateVerify(headers, url, {
      requestId: 'unknown',
      response: { ...AUTH_RESPONSE, id: 'cred-9', rawId: 'cred-9' },
    }, '40.0.0.1');
    expect(failId.status).toBe(400);

    const ok = await pk.authenticateVerify(headers, url, {
      requestId: optionsBody.requestId,
      trustDevice: true,
      response: AUTH_RESPONSE,
    }, '40.0.0.2');
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ authenticated: true });
    expect((ok as unknown as { setCookie?: string }).setCookie).toContain('Max-Age=604800');
    expect(ceremony.lastAuth?.expectedChallenge).toBe(optionsBody.challenge);
    expect((pk.listFor(headers, url).body as { passkeys: { counter: number }[] }).passkeys[0]?.counter).toBe(1);

    expect((await pk.authenticateVerify(headers, url, { requestId: optionsBody.requestId, response: AUTH_RESPONSE }, '40.0.0.3')).status).toBe(400); // replay
    delete process.env.NOTNATIVE_UI_PASSWORD;
    resetUiAuthForTests();
  });

  it('passkey verification rides the login rate limiter: 10 fails lock 15 minutes', async () => {
    let clock = 1000;
    const dir = freshScratch();
    const ceremony = fakeCeremony();
    const pk = storePasskey(dir, { ceremony, password: 'hunter2', now: () => clock });
    const headers = new Headers({ host: 'localhost' });
    const url = new URL('http://localhost/x');
    await registerOne(pk, headers, url);
    for (let index = 0; index < 10; index++) {
      const attempt = await pk.authenticateVerify(headers, url, { requestId: 'wrong', response: AUTH_RESPONSE }, '41.0.0.1');
      expect(attempt.status).toBe(400);
    }
    const locked = await pk.authenticateVerify(headers, url, {}, '41.0.0.1');
    expect(locked.status).toBe(429);
    expect(locked.headers?.['x-ratelimit-limit']).toBe('10');
    delete process.env.NOTNATIVE_UI_PASSWORD;
    resetUiAuthForTests();
  });

  it('revoke matches id AND rpID; auth-reset purge clears everything (E-08-3)', async () => {
    const dir = freshScratch();
    const ceremony = fakeCeremony();
    const pk = storePasskey(dir, { ceremony, password: 'hunter2', now: () => 1000 });
    const headers = new Headers({ host: 'localhost' });
    const url = new URL('http://localhost/x');
    await registerOne(pk, headers, url);
    expect(pk.revoke('cred-9', headers, url).status).toBe(404);
    expect(pk.revoke('cred-1', new Headers({ host: 'vpn.example.com' }), new URL('https://vpn.example.com/x')).status).toBe(404); // rpID mismatch
    expect((pk.listFor(new Headers({ host: 'vpn.example.com' }), new URL('https://vpn.example.com/x')).body as { passkeys: unknown[] }).passkeys).toHaveLength(0);
    expect(pk.revoke('cred-1', headers, url).status).toBe(200);
    expect((pk.listFor(headers, url).body as { passkeys: unknown[] }).passkeys).toHaveLength(0);

    await registerOne(pk, headers, url);
    pk.resetForAuthReset();
    expect((pk.listFor(headers, url).body as { passkeys: unknown[] }).passkeys).toHaveLength(0);
    delete process.env.NOTNATIVE_UI_PASSWORD;
    resetUiAuthForTests();
  });

  it('store hygiene: corrupted JSON and a mis-shaped userID regenerate instead of tainting options bytes', async () => {
    const dir = freshScratch();
    // total corruption -> the store is re-created with a clean 32B handle
    writeFileSync(joinPath(dir, 'ui-passkeys.json'), 'garbage{');
    storePasskey(dir, { ceremony: fakeCeremony(), password: 'hunter2' });
    const rebuilt = JSON.parse(readFileSync(joinPath(dir, 'ui-passkeys.json'), 'utf8')) as { userID: string; passkeys: unknown[] };
    expect(rebuilt.userID).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(Buffer.from(rebuilt.userID, 'base64url').byteLength).toBe(32);
    expect(rebuilt.passkeys).toHaveLength(0);

    // shape-valid file whose userID is NOT 32B b64url: the correct binding
    // no longer rescues it - the whole store regenerates (a corrupted user
    // handle must never flow verbatim into registration option bytes)
    const secret = readFileSync(joinPath(isolatedDataDir, 'jwt-secret'), 'utf8');
    const binding = createHmac('sha256', secret).update('hunter2').digest('hex');
    writeFileSync(joinPath(dir, 'ui-passkeys.json'), JSON.stringify({
      version: 1, userID: 'AAAA', passwordBinding: binding, passkeys: [],
    }));
    const pk = storePasskey(dir, { ceremony: fakeCeremony(), password: 'hunter2' });
    const regenerated = JSON.parse(readFileSync(joinPath(dir, 'ui-passkeys.json'), 'utf8')) as { userID: string };
    expect(regenerated.userID).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(regenerated.userID).not.toBe('AAAA');
    await registerOne(pk, new Headers({ host: 'localhost' }), new URL(`${origin}/x`));
    expect((pk.listFor(new Headers({ host: 'localhost' }), new URL(`${origin}/x`)).body as { passkeys: unknown[] }).passkeys).toHaveLength(1);
    delete process.env.NOTNATIVE_UI_PASSWORD;
    resetUiAuthForTests();
  });

  it('transports are laundered to the IANA token set (deduplicated, junk dropped) before the store write', async () => {
    const dir = freshScratch();
    const ceremony = fakeCeremony();
    ceremony.verifyRegistration = async (input) => {
      void input;
      return {
        verified: true,
        registrationInfo: {
          credential: {
            id: 'cred-t', publicKey: new Uint8Array([1, 2, 3]), counter: 0,
            transports: ['internal', 'Not-A-Transport', ' USB ', 'usb', 'usb', 42 as unknown as string, 'hybrid'],
          },
          credentialDeviceType: 'singleDevice',
          credentialBackedUp: false,
        },
      };
    };
    const pk = storePasskey(dir, { ceremony, password: 'hunter2' });
    const headers = new Headers({ host: 'localhost' });
    const url = new URL(`${origin}/x`);
    await registerOne(pk, headers, url);
    const stored = (pk.listFor(headers, url).body as { passkeys: { id: string; transports?: string[] }[] }).passkeys[0];
    expect(stored?.transports).toStrictEqual(['internal', 'usb', 'hybrid']);
    const next = (await pk.registerOptions(headers, url)).body as { excludeCredentials: { id: string; transports?: string[] }[] };
    expect(next.excludeCredentials).toStrictEqual([{ id: 'cred-t', transports: ['internal', 'usb', 'hybrid'] }]);
    delete process.env.NOTNATIVE_UI_PASSWORD;
    resetUiAuthForTests();
  });
});

describe('passkey routes (singleton app, real ceremony at the guards)', () => {
  beforeEach(() => {
    resetTunnelAuthForTests();
    resetPasskeysForTests();
    resetUiAuthForTests();
  });

  it('register family is session-cookie-only; management refuses bearers; open-mode disabled', async () => {
    setEnvPassword('hunter2');
    expect((await call('/auth/passkey/register/options', { method: 'POST', body: '{}' })).status).toBe(401);
    const cookie = await loginForCookie();
    const ok = await call('/auth/passkey/register/options', { method: 'POST', headers: { cookie }, body: '{}' });
    expect(ok.status).toBe(200);
    const requestId = (await ok.json() as { requestId: string }).requestId;
    const verify = await call('/auth/passkey/register/verify', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId, response: REG_RESPONSE }),
    });
    expect(verify.status).toBe(400); // the real ceremony rejects a fake response object
    expect(await verify.json()).toMatchObject({ verified: false });

    const list = await call('/api/passkeys', { headers: { cookie } });
    expect(list.status).toBe(200);
    const bearerDenied = await call('/api/passkeys', { headers: { authorization: 'Bearer oc_client_zzz' } });
    expect(bearerDenied.status).toBe(401);
    clearEnvPassword();
    const open = await call('/auth/passkey/register/options', { method: 'POST', body: '{}' });
    expect(open.status).toBe(400);
    expect(await open.json()).toMatchObject({ error: PASSKEYS_DISABLED_TEXT });
  });

  it('authenticate family works anonymously and fails closed without registrations', async () => {
    setEnvPassword('hunter2');
    const options = await call('/auth/passkey/authenticate/options', { method: 'POST', body: '{}' });
    expect(options.status).toBe(400); // no passkeys registered for this rp yet
    const verify = await call('/auth/passkey/authenticate/verify', {
      method: 'POST',
      headers: { 'x-forwarded-for': '50.0.0.1' },
      body: JSON.stringify({ requestId: 'x', response: AUTH_RESPONSE }),
    });
    expect(verify.status).toBe(400);
    clearEnvPassword();
  });

  it('tunnel scope hard-403s the whole family regardless of credentials', async () => {
    setEnvPassword('hunter2');
    const tunnel = getTunnelAuthController();
    tunnel.setActiveTunnel({ publicUrl: 'https://tunnel.example.com', mode: 'quick' });
    const issued = tunnel.issueBootstrapToken();
    const entrance = await callAt(`/connect?t=${issued.token}`, 'http://tunnel.example.com');
    const tunnelCookie = (setCookies(entrance).find((value) => value.startsWith(TUNNEL_COOKIE_NAME)) ?? '').split(';')[0] ?? '';
    for (const [path, init] of [
      ['/auth/passkey/register/options', { method: 'POST', body: '{}' }],
      ['/auth/passkey/register/verify', { method: 'POST', body: '{}' }],
      ['/auth/passkey/authenticate/options', { method: 'POST', body: '{}' }],
      ['/auth/passkey/authenticate/verify', { method: 'POST', body: '{}' }],
      ['/api/passkeys', {}],
    ] as [string, RequestInit][]) {
      const response = await callAt(path, 'http://tunnel.example.com', { ...init, headers: { ...(init.headers ?? {}), cookie: tunnelCookie } });
      // with a valid tunnel session /api/* rows pass the gate and land on the
      // family's hard lock; the /auth/* rows hit the same lock directly
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: 'Passkey endpoints are disabled for tunnel scope',
        tunnelLocked: true,
      });
    }
    clearEnvPassword();
  });

  it('auth reset purges passkeys on the same singleton (E-08-3 completion)', async () => {
    setEnvPassword('hunter2');
    const cookie = await loginForCookie();
    // seed through an injected-ceremony controller on the SAME dataDir, then
    // build the route singleton from the persisted store
    const seeded = createUiPasskeysController({ dataDir: isolatedDataDir, uiAuth: getUiAuthController(), ceremony: fakeCeremony() });
    await registerOne(seeded, new Headers({ host: 'localhost' }), new URL(`${origin}/x`));
    resetPasskeysForTests();
    const routePk = getUiPasskeysController(() => getUiAuthController(), isolatedDataDir);
    expect((routePk.listFor(new Headers({ host: 'localhost' }), new URL(`${origin}/x`)).body as { passkeys: unknown[] }).passkeys).toHaveLength(1);
    const reset = await call('/api/auth/reset', { method: 'POST', headers: { cookie } });
    expect(reset.status).toBe(200);
    expect((routePk.listFor(new Headers({ host: 'localhost' }), new URL(`${origin}/x`)).body as { passkeys: unknown[] }).passkeys).toHaveLength(0);
    clearEnvPassword();
  });

  it('REAL ceremony end to end: ported origin registration + anonymous login issues the session cookie', { timeout: 30_000 }, async () => {
    setEnvPassword('hunter2');
    // Host localhost:3902 -> rpID 'localhost', expected origin
    // 'http://localhost:3902' (the pre-fix derivation answered
    // 'http://localhost', which the exact-string origin compare rejected).
    const hostOrigin = 'http://localhost:3902';
    const cookie = await loginForCookie();
    const options = await callAt('/auth/passkey/register/options', hostOrigin, { method: 'POST', headers: { cookie } });
    expect(options.status).toBe(200);
    const optionsBody = await options.json() as { requestId: string; challenge: string; rp: { id?: string; name: string } };
    expect(optionsBody.rp.id).toBe('localhost');
    const auth = syntheticAuthenticator(hostOrigin, 'localhost');
    const register = await callAt('/auth/passkey/register/verify', hostOrigin, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: optionsBody.requestId, label: 'E2E key', response: registrationFixture(auth, optionsBody.challenge) }),
    });
    expect(register.status).toBe(200); // would be 400 (origin mismatch) before the port fix
    expect(await register.json()).toMatchObject({ verified: true });

    // non-default port is REQUIRED: a browser on the scheme-default origin fails
    const plainOptions = await callAt('/auth/passkey/register/options', hostOrigin, { method: 'POST', headers: { cookie } });
    const plainBody = await plainOptions.json() as { requestId: string; challenge: string };
    const misOrigin = syntheticAuthenticator(origin, 'localhost');
    const wrong = await callAt('/auth/passkey/register/verify', hostOrigin, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: plainBody.requestId, response: registrationFixture(misOrigin, plainBody.challenge) }),
    });
    expect(wrong.status).toBe(400); // 'http://localhost' != expected 'http://localhost:3902'
    expect(await wrong.json()).toMatchObject({ verified: false });

    // anonymous authentication over the REAL lib: counter bump + grantedLogin cookie
    const authOptions = await callAt('/auth/passkey/authenticate/options', hostOrigin, { method: 'POST' });
    expect(authOptions.status).toBe(200);
    const authBody = await authOptions.json() as { requestId: string; challenge: string; allowCredentials: { id: string }[] };
    expect(authBody.allowCredentials.map((entry) => entry.id)).toContain(auth.credentialId);
    const verified = await callAt('/auth/passkey/authenticate/verify', hostOrigin, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '60.0.0.1' },
      body: JSON.stringify({
        requestId: authBody.requestId, trustDevice: true,
        response: assertionFixture(auth, authBody.challenge, auth.counter + 1),
      }),
    });
    expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({ authenticated: true });
    // the grantedLogin tail must CARRY the cookie at the route boundary
    const granted = setCookies(verified).find((value) => value.startsWith(UI_SESSION_COOKIE)) ?? '';
    expect(granted).toContain('oc_ui_session=');
    expect(granted).toContain('HttpOnly');
    expect(granted).toContain('Path=/');

    // the issued cookie works (counter bump persisted; management visible)
    const list = await callAt('/api/passkeys', hostOrigin, {
      headers: { cookie: granted.split(';')[0] ?? '' },
    });
    expect(list.status).toBe(200);
    const stored = await list.json() as { passkeys: { id: string; counter: number }[] };
    const mine = stored.passkeys.find((record) => record.id === auth.credentialId);
    expect(mine?.counter).toBe(auth.counter + 1);
    // revoke through the real route with the passkey-issued cookie
    const revoked = await callAt(`/api/passkeys/${encodeURIComponent(auth.credentialId)}`, hostOrigin, {
      method: 'DELETE',
      headers: { cookie: granted.split(';')[0] ?? '' },
    });
    expect(revoked.status).toBe(200);
    clearEnvPassword();
  });
});

it('REAL ceremony accepts the configured additional origin and still rejects wrong origins and RP hashes', async () => {
  const reader = vi.spyOn(settingsStore, 'readPublicOrigin').mockReturnValue('https://localhost:8443');
  setEnvPassword('hunter2');
  const headers = new Headers({ host: 'localhost:3902' }); const url = new URL('http://localhost:3902/auth/passkey');
  // Use the real adapter instead of the machine fixture.
  const { realCeremony } = await import('../lib/auth/webauthn-ceremony.ts');
  const real = createUiPasskeysController({ dataDir: freshScratch(), uiAuth: getUiAuthController(), ceremony: realCeremony });
  const auth = syntheticAuthenticator('https://localhost:8443', 'localhost');
  try {
    const registration = await real.registerOptions(headers, url);
    expect((await real.registerVerify(headers, url, { requestId: registration.body.requestId,
      response: registrationFixture(auth, String(registration.body.challenge)) })).status).toBe(200);
    const options = await real.authenticationOptions(headers, url);
    expect((await real.authenticateVerify(headers, url, { requestId: options.body.requestId,
      response: assertionFixture(auth, String(options.body.challenge), 1) }, '60.0.0.2')).status).toBe(200);
    for (const [origin, rpID] of [['https://localhost:8444', 'localhost'], ['https://localhost:8443', 'other.example']] as const) {
      const next = await real.authenticationOptions(headers, url);
      expect((await real.authenticateVerify(headers, url, { requestId: next.body.requestId,
        response: assertionFixture({ ...auth, origin, rpID }, String(next.body.challenge), 2) }, '60.0.0.2')).status).toBe(400);
    }
  } finally { reader.mockRestore(); clearEnvPassword(); }
});

/** A server-side synthetic P-256 authenticator: real crypto (node KeyPair),
 * hand-rolled CBOR/COSE bytes for attestation 'none' + ES256 assertions. */
interface SyntheticAuth {
  credentialId: string;
  idBytes: Buffer;
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  coseKey: Buffer;
  origin: string; // scheme://host(:port) exactly as the browser would report
  rpID: string;
  counter: number;
}

type CborValue = number | string | Uint8Array | { pairs: [CborValue, CborValue][] };

function cborInt(value: number): number[] {
  if (value >= 0 && value < 24) return [value];
  if (value < 0x100) return [0x18, value];
  if (value < 0x1_0000) return [0x19, (value >> 8) & 0xff, value & 0xff];
  if (value < 4_294_967_296) {
    return [0x1a, (value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
  }
  throw new RangeError('fixture integer out of CBOR range');
}

function encodeCbor(out: number[], value: CborValue): void {
  if (typeof value === 'number' && Number.isInteger(value)) {
    const unit = value >= 0 ? cborInt(value) : cborInt(-value - 1);
    if (value < 0) unit[0] = (unit[0] ?? 0) | 0x20; // negative major over the same length header
    out.push(...unit);
    return;
  }
  if (value instanceof Uint8Array) {
    out.push(...cborHeaderOf(2, value.length), ...value);
    return;
  }
  if (typeof value === 'string') {
    const raw = Buffer.from(value, 'utf8');
    out.push(...cborHeaderOf(3, raw.length), ...raw);
    return;
  }
  if (value !== null && typeof value === 'object' && 'pairs' in value) {
    out.push(...cborHeaderOf(5, value.pairs.length));
    for (const [key, item] of value.pairs) {
      encodeCbor(out, key);
      encodeCbor(out, item);
    }
    return;
  }
  throw new TypeError('unsupported CBOR fixture value');
}

function cborHeaderOf(major: number, length: number): number[] {
  if (length < 24) return [(major << 5) | length];
  if (length < 0x100) return [(major << 5) | 0x18, length];
  if (length < 0x1_0000) return [(major << 5) | 0x19, (length >> 8) & 0xff, length & 0xff];
  return [(major << 5) | 0x1a, (length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff];
}

function cborEncode(value: CborValue): Buffer {
  const out: number[] = [];
  encodeCbor(out, value);
  return Buffer.from(out);
}

const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

function syntheticAuthenticator(origin: string, rpID: string): SyntheticAuth {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = pair.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const idBytes = randomBytes(32);
  const coseKey = cborEncode({
    pairs: [
      [1, 2], [3, -7], [-1, 1],
      [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')],
    ],
  });
  return {
    credentialId: b64u(idBytes),
    idBytes,
    privateKey: pair.privateKey,
    coseKey: Buffer.from(coseKey),
    origin,
    rpID,
    counter: 0,
  };
}

function authenticatorData(rpID: string, flags: number, counter: number, tail?: Uint8Array): Buffer {
  const rpIdHash = createHash('sha256').update(rpID, 'utf8').digest();
  const counterBytes = Buffer.alloc(4);
  counterBytes.writeUInt32BE(counter >>> 0, 0);
  return Buffer.concat([rpIdHash, Buffer.from([flags]), counterBytes, ...(tail !== undefined ? [tail] : [])]);
}

function attestedCredentialData(credentialId: Buffer, coseKey: Buffer): Buffer {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(credentialId.length, 0);
  return Buffer.concat([Buffer.alloc(16), length, credentialId, coseKey]); // zero AAGUID (16B)
}

function registrationFixture(auth: SyntheticAuth, challenge: string): unknown {
  const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin: auth.origin }), 'utf8');
  const authData = authenticatorData(auth.rpID, 0x45, 0, attestedCredentialData(auth.idBytes, auth.coseKey)); // UP|UV|AT
  const attestationObject = cborEncode({ pairs: [['fmt', 'none'], ['attStmt', { pairs: [] }], ['authData', authData]] });
  return {
    id: auth.credentialId, rawId: auth.credentialId, type: 'public-key',
    response: { clientDataJSON: b64u(clientData), attestationObject: b64u(attestationObject), transports: ['internal'] },
  };
}

function assertionFixture(auth: SyntheticAuth, challenge: string, counter: number): unknown {
  const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: auth.origin }), 'utf8');
  const clientHash = createHash('sha256').update(clientData).digest();
  const authData = authenticatorData(auth.rpID, 0x05, counter); // UP|UV
  const signature = sign('sha256', Buffer.concat([authData, clientHash]), auth.privateKey);
  return {
    id: auth.credentialId, rawId: auth.credentialId, type: 'public-key',
    response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(signature) },
  };
}
