// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import {
  PASSKEY_ENDPOINTS,
  actionFailure,
  authenticateWithPasskey,
  cancelPasskeyCeremony,
  createPasskeyLibrary,
  createPasskeyRuntime,
  getPasskeySupportState,
  isPasskeyCeremonyAbort,
  isPasskeysDisabledText,
  listPasskeys,
  passkeyLabel,
  registerCurrentDevicePasskey,
  resetPasskeyAuth,
  revokePasskey,
} from '../passkeys.ts';
import type { PasskeyRuntime } from '../passkeys.ts';
import { setRuntimeBearerToken } from '../runtime-auth.ts';

vi.mock('../runtime-auth.ts', () => ({ setRuntimeBearerToken: vi.fn() }));

const bearerCleared = vi.mocked(setRuntimeBearerToken);

/** Shape the server's options hop returns: `{...options, requestId}`. */
function optionsBody(requestId = 'req-1'): Record<string, unknown> {
  return { challenge: 'chal-1', rp: { id: 'localhost', name: 'NNA' }, requestId };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function abortError(): Error {
  return Object.assign(new Error('Manually cancelling existing WebAuthn API call'), { name: 'AbortError' });
}

function codedError(code: string): Error {
  return Object.assign(new Error('Cancelling existing WebAuthn API call for new one'), { code });
}

interface FakeCall {
  endpoint: string;
  init: RequestInit;
  body: Record<string, unknown> | undefined;
}

type Responders = Array<(body: unknown) => Response>;

interface Fake {
  runtime: PasskeyRuntime;
  calls: FakeCall[];
  start: Mock;
  register: Mock;
  responders: Map<string, Responders>;
}

function fakeRuntime(overrides: Partial<PasskeyRuntime> = {}): Fake {
  const calls: FakeCall[] = [];
  const responders = new Map<string, Array<(body: unknown) => Response>>();
  const fallback = vi.fn(async (_body: unknown) => jsonResponse(200, optionsBody()));
  const runtime: PasskeyRuntime = {
    fetch: vi.fn(async (input: RequestInfo, init?: RequestInit): Promise<Response> => {
      const endpoint = String(input);
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      calls.push({ endpoint, init: init ?? {}, body });
      const queue = responders.get(endpoint);
      if (queue === undefined || queue.length === 0) return fallback(body);
      const responder = queue.length > 1 ? queue.shift() : queue[0];
      return (responder ?? fallback)(body);
    }) as unknown as PasskeyRuntime['fetch'],
    startRegistration: vi.fn(async () => ({
      id: 'cred-1', rawId: 'cred-1', response: {}, type: 'public-key',
    })) as unknown as PasskeyRuntime['startRegistration'],
    startAuthentication: vi.fn(async () => ({
      id: 'cred-1', rawId: 'cred-1', response: {}, type: 'public-key',
    })) as unknown as PasskeyRuntime['startAuthentication'],
    supportsPasskeys: vi.fn(async () => true) as unknown as PasskeyRuntime['supportsPasskeys'],
    supportsWebAuthn: vi.fn(() => true) as unknown as PasskeyRuntime['supportsWebAuthn'],
    abortService: { cancelCeremony: vi.fn() } as unknown as PasskeyRuntime['abortService'],
    secureContext: () => true,
    userAgent: () => 'Mozilla/5.0 (TestWare)',
    ...overrides,
  };
  return {
    runtime,
    calls,
    responders,
    start: runtime.startAuthentication as unknown as Mock,
    register: runtime.startRegistration as unknown as Mock,
  };
}

function serve(fake: Fake, endpoint: string, ...responders: Responders): void {
  fake.responders.set(endpoint, responders);
}

beforeEach(() => {
  bearerCleared.mockClear();
});

describe('passkey support state (doc 08 §2.5)', () => {
  it('refuses on an insecure origin before probing anything', async () => {
    const supportsPasskeys = vi.fn(async () => true);
    const state = await getPasskeySupportState(
      fakeRuntime({ secureContext: () => false, supportsPasskeys: supportsPasskeys as never }).runtime,
    );
    expect(state.level).toBe('unsupported');
    expect(state.reason).toBe('Passkeys require HTTPS or localhost');
    expect(supportsPasskeys).not.toHaveBeenCalled();
  });

  it('reports no-WebAuthn separately from no-passkey-authenticator', async () => {
    const noWebAuthn = await getPasskeySupportState(
      fakeRuntime({ supportsWebAuthn: vi.fn(() => false) as never }).runtime,
    );
    expect(noWebAuthn.reason).toBe('This browser does not support WebAuthn');
    const noAuthenticator = await getPasskeySupportState(
      fakeRuntime({ supportsPasskeys: vi.fn(async () => false) as never }).runtime,
    );
    expect(noAuthenticator).toMatchObject({ level: 'unsupported', webauthn: true, passkeys: false });
    expect(noAuthenticator.reason).toBe('No passkey authenticator is available');
  });

  it('treats a throwing capability probe as unsupported, not a crash', async () => {
    const state = await getPasskeySupportState(
      fakeRuntime({ supportsPasskeys: vi.fn(async () => { throw new Error('boom'); }) as never }).runtime,
    );
    expect(state.level).toBe('unsupported');
  });

  it('reports available when secure and capable', async () => {
    const state = await getPasskeySupportState(fakeRuntime().runtime);
    expect(state).toMatchObject({ level: 'available', secureContext: true, webauthn: true, passkeys: true });
    expect(state.reason).toBeUndefined();
  });
});

describe('ceremony abort classification (§2.5)', () => {
  it('accepts both abort shapes the library raises', () => {
    expect(isPasskeyCeremonyAbort(abortError())).toBe(true);
    expect(isPasskeyCeremonyAbort(codedError('ERROR_CEREMONY_ABORTED'))).toBe(true);
    expect(isPasskeyCeremonyAbort(new Error('NotAllowedError'))).toBe(false);
    expect(isPasskeyCeremonyAbort('nope')).toBe(false);
    expect(isPasskeyCeremonyAbort(null)).toBe(false);
    expect(isPasskeyCeremonyAbort(undefined)).toBe(false);
  });

  it('classifies a user cancel as cancelled, not as a login failure', async () => {
    const fake = fakeRuntime();
    fake.start.mockRejectedValueOnce(abortError());
    const result = await authenticateWithPasskey(fake.runtime, false);
    expect(result).toMatchObject({
      ok: false, authenticated: false, error: 'cancelled', clientToken: null, status: 200,
    });
  });

  it('surfaces a real authenticator breakage as its message', async () => {
    const fake = fakeRuntime();
    fake.start.mockRejectedValueOnce(new Error('authenticator exploded'));
    const result = await authenticateWithPasskey(fake.runtime, false);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('authenticator exploded');
  });
});

describe('passkey login ceremony (§2.4/§2.5)', () => {
  it('sends the requestId and cookie credentials, and keeps trustDevice', async () => {
    const fake = fakeRuntime();
    serve(fake, PASSKEY_ENDPOINTS.authenticateOptions, () => jsonResponse(200, optionsBody('req-77')));
    serve(fake, PASSKEY_ENDPOINTS.authenticateVerify, () => jsonResponse(200, { authenticated: true }));
    const result = await authenticateWithPasskey(fake.runtime, true);
    expect(result).toMatchObject({ ok: true, authenticated: true, clientToken: null, status: 200 });
    const verify = fake.calls[1];
    expect(verify?.endpoint).toBe(PASSKEY_ENDPOINTS.authenticateVerify);
    expect(verify?.init.method).toBe('POST');
    expect(verify?.init.credentials).toBe('include');
    expect(verify?.body).toMatchObject({ requestId: 'req-77', trustDevice: true, id: 'cred-1' });
    expect(verify?.body?.issueClientToken).toBe(false);
    expect(verify?.body?.challenge).toBeUndefined();
  });

  it('never leaks the requestId to the authenticator', async () => {
    const fake = fakeRuntime();
    serve(fake, PASSKEY_ENDPOINTS.authenticateOptions, () =>
      jsonResponse(200, { ...optionsBody('req-77'), allowCredentials: ['x'] }));
    serve(fake, PASSKEY_ENDPOINTS.authenticateVerify, () => jsonResponse(200, { authenticated: true }));
    await authenticateWithPasskey(fake.runtime, false);
    const started = fake.start.mock.calls[0]?.[0] as { optionsJSON: Record<string, unknown> };
    expect(started.optionsJSON.requestId).toBeUndefined();
    expect(started.optionsJSON.allowCredentials).toEqual(['x']);
  });

  it('carries the desktop mint fields when asked', async () => {
    const fake = fakeRuntime();
    serve(fake, PASSKEY_ENDPOINTS.authenticateVerify, () =>
      jsonResponse(200, { authenticated: true, clientToken: 'nnd_client_abc' }));
    const result = await authenticateWithPasskey(fake.runtime, false, {
      issueClientToken: true,
      clientKind: 'desktop',
      deviceName: 'Studio',
      devicePlatform: '   ',
      appVersion: '20260919-1',
    });
    expect(result.clientToken).toBe('nnd_client_abc');
    const body = fake.calls[1]?.body;
    expect(body).toMatchObject({
      issueClientToken: true, clientKind: 'desktop', deviceName: 'Studio', appVersion: '20260919-1',
    });
    expect(body?.devicePlatform).toBeUndefined();
  });

  it('reports the tunnel lock without touching the authenticator', async () => {
    const fake = fakeRuntime();
    serve(fake, PASSKEY_ENDPOINTS.authenticateOptions, () =>
      jsonResponse(403, { error: 'Passkey login is disabled for tunnel scope', tunnelLocked: true }));
    const result = await authenticateWithPasskey(fake.runtime, false);
    expect(result).toMatchObject({ ok: false, status: 403, tunnelLocked: true, authenticated: false });
    expect(fake.start).not.toHaveBeenCalled();
  });

  it('flags the no-password refusal as passkeysDisabled', async () => {
    const fake = fakeRuntime();
    serve(fake, PASSKEY_ENDPOINTS.authenticateOptions, () =>
      jsonResponse(400, { error: 'Passkeys require UI password protection to be enabled' }));
    expect(await authenticateWithPasskey(fake.runtime, false))
      .toMatchObject({ ok: false, status: 400, passkeysDisabled: true });
  });

  it('refuses an options hop that never produced a requestId', async () => {
    const fake = fakeRuntime();
    serve(fake, PASSKEY_ENDPOINTS.authenticateOptions, () => jsonResponse(200, { challenge: 'orphan' }));
    expect((await authenticateWithPasskey(fake.runtime, false)).ok).toBe(false);
    expect(fake.start).not.toHaveBeenCalled();
  });

  it('classifies a non-JSON verify body by status alone', async () => {
    const fake = fakeRuntime();
    serve(fake, PASSKEY_ENDPOINTS.authenticateVerify, () => new Response('gateway blew up', { status: 502 }));
    expect(await authenticateWithPasskey(fake.runtime, false))
      .toMatchObject({ ok: false, status: 502, error: 'HTTP 502' });
  });

  it('honours the login rate limit body', async () => {
    const fake = fakeRuntime();
    serve(fake, PASSKEY_ENDPOINTS.authenticateVerify, () =>
      jsonResponse(429, { error: 'Too many failed login attempts', locked: true }));
    expect(await authenticateWithPasskey(fake.runtime, false))
      .toMatchObject({ ok: false, status: 429, locked: true });
  });
});

describe('passkey registration (§2.4/§2.5)', () => {
  it('labels the key with the user agent when unspecified', async () => {
    const fake = fakeRuntime();
    serve(fake, PASSKEY_ENDPOINTS.registerVerify, () => jsonResponse(200, { verified: true }));
    expect(await registerCurrentDevicePasskey(fake.runtime)).toEqual({ ok: true, status: 200 });
    expect(fake.calls[1]?.body).toMatchObject({ label: 'Mozilla/5.0 (TestWare)', requestId: 'req-1' });
    const started = fake.register.mock.calls[0]?.[0] as { useAutoRegister?: boolean };
    expect(started.useAutoRegister).toBe(false);
  });

  it('prefers the caller label and clamps to the server cap', async () => {
    const fake = fakeRuntime();
    serve(fake, PASSKEY_ENDPOINTS.registerVerify, () => jsonResponse(200, { verified: true }));
    await registerCurrentDevicePasskey(fake.runtime, `   ${'k'.repeat(400)}   `);
    const label = String(fake.calls[1]?.body?.label);
    expect(label).toHaveLength(120);
    expect(label.startsWith('k')).toBe(true);
  });

  it('falls back to "This device" without a user agent', () => {
    expect(passkeyLabel(fakeRuntime({ userAgent: () => '   ' }).runtime)).toBe('This device');
  });

  it('reports verify rejection as a failure', async () => {
    const fake = fakeRuntime();
    serve(fake, PASSKEY_ENDPOINTS.registerVerify, () =>
      jsonResponse(400, { verified: false, error: 'attestation rejected' }));
    expect(await registerCurrentDevicePasskey(fake.runtime))
      .toMatchObject({ ok: false, status: 400, error: 'attestation rejected' });
  });

  it('classifies a registration cancel', async () => {
    const fake = fakeRuntime();
    fake.register.mockRejectedValueOnce(codedError('ERROR_CEREMONY_ABORTED'));
    expect(await registerCurrentDevicePasskey(fake.runtime)).toMatchObject({ ok: false, error: 'cancelled' });
  });
});

describe('passkey management (§2.4)', () => {
  it('lists only rows with both id and rpID', async () => {
    const fake = fakeRuntime();
    serve(fake, PASSKEY_ENDPOINTS.list, () =>
      jsonResponse(200, {
        rpID: 'localhost',
        passkeys: [
          { id: 'a', rpID: 'localhost', label: 'Pixel', counter: 7, transports: ['internal', 5], backedUp: true },
          { id: '', rpID: 'localhost' },
          { id: 'b' },
          'garbage',
        ],
      }));
    const listed = await listPasskeys(fake.runtime);
    expect(listed.ok).toBe(true);
    expect(listed.rpID).toBe('localhost');
    expect(listed.passkeys).toHaveLength(1);
    expect(listed.passkeys[0]).toMatchObject({ id: 'a', label: 'Pixel', counter: 7, backedUp: true });
    expect(listed.passkeys[0]?.transports).toEqual(['internal']);
    expect(fake.calls[0]?.init.method).toBe('GET');
    expect(fake.calls[0]?.init.body).toBeUndefined();
  });

  it('url-encodes the revoked id and refuses an empty one', async () => {
    const fake = fakeRuntime();
    serve(fake, `${PASSKEY_ENDPOINTS.list}/a%2Fb`, () => jsonResponse(200, { revoked: 'a/b' }));
    expect(await revokePasskey(fake.runtime, ' a/b ')).toEqual({ ok: true, status: 200 });
    expect(fake.calls[0]?.init.method).toBe('DELETE');
    expect(await revokePasskey(fake.runtime, '   ')).toMatchObject({ ok: false, status: 0 });
    expect(fake.calls).toHaveLength(1);
  });

  it('clears the bearer token only after a successful global reset', async () => {
    const fake = fakeRuntime();
    serve(fake, PASSKEY_ENDPOINTS.reset, () =>
      jsonResponse(401, { error: 'UI authentication required', locked: true }),
      () => jsonResponse(200, { authenticated: false, reset: true }));
    expect(await resetPasskeyAuth(fake.runtime)).toMatchObject({ ok: false, status: 401 });
    expect(bearerCleared).not.toHaveBeenCalled();
    expect(await resetPasskeyAuth(fake.runtime)).toEqual({ ok: true, status: 200 });
    expect(bearerCleared).toHaveBeenCalledWith(null);
  });

  it('classifies disabled management calls', async () => {
    const fake = fakeRuntime();
    serve(fake, PASSKEY_ENDPOINTS.list, () =>
      jsonResponse(400, { error: 'Passkeys require UI password protection to be enabled' }));
    expect(await listPasskeys(fake.runtime))
      .toMatchObject({ ok: false, status: 400, passkeysDisabled: true });
  });
});

describe('ceremony transport tolerance (§2.5, §6.6.4 posture)', () => {
  it('a throwing options hop refuses the login as a shaped failure, never a rejection', async () => {
    const fake = fakeRuntime();
    fake.runtime.fetch = (async () => {
      throw new Error('relay not up');
    }) as unknown as PasskeyRuntime['fetch'];
    const result = await authenticateWithPasskey(fake.runtime, false);
    expect(result).toMatchObject({ ok: false, status: 0, error: 'relay not up' });
    expect(fake.start).not.toHaveBeenCalled();
  });

  it('a throwing verify hop classifies as a transport failure, not a crash', async () => {
    const fake = fakeRuntime();
    serve(fake, PASSKEY_ENDPOINTS.authenticateOptions, () => jsonResponse(200, optionsBody('req-88')));
    serve(fake, PASSKEY_ENDPOINTS.authenticateVerify, () => {
      throw new Error('socket reset');
    });
    fake.start.mockResolvedValueOnce({ id: 'cred-1', rawId: 'cred-1', response: {}, type: 'public-key' });
    const result = await authenticateWithPasskey(fake.runtime, true, { issueClientToken: true });
    expect(result).toMatchObject({ ok: false, authenticated: false, status: 0, error: 'socket reset' });
    expect(result.clientToken).toBeNull();
  });

  it('a throwing registration verify is shaped the same way', async () => {
    const fake = fakeRuntime();
    serve(fake, PASSKEY_ENDPOINTS.registerOptions, () => jsonResponse(200, optionsBody('req-89')));
    serve(fake, PASSKEY_ENDPOINTS.registerVerify, () => {
      throw new Error('tunnel closed');
    });
    expect(await registerCurrentDevicePasskey(fake.runtime))
      .toMatchObject({ ok: false, status: 0, error: 'tunnel closed' });
  });

  it('management calls degrade to status 0 instead of throwing', async () => {
    const fake = fakeRuntime();
    fake.runtime.fetch = (async () => {
      throw new Error('host unreachable');
    }) as unknown as PasskeyRuntime['fetch'];
    expect(await listPasskeys(fake.runtime)).toMatchObject({ ok: false, status: 0, error: 'host unreachable', passkeys: [] });
    expect(await revokePasskey(fake.runtime, 'pk_1')).toMatchObject({ ok: false, status: 0, error: 'host unreachable' });
    expect(await resetPasskeyAuth(fake.runtime)).toMatchObject({ ok: false, status: 0, error: 'host unreachable' });
    // a failed reset never wipes a live bearer (§2.2_side effect is success-only)
    expect(bearerCleared).not.toHaveBeenCalled();
  });

  it('a register options throw keeps the ceremony untouched', async () => {
    const fake = fakeRuntime();
    fake.runtime.fetch = (async () => {
      throw new Error('gateway down');
    }) as unknown as PasskeyRuntime['fetch'];
    expect(await registerCurrentDevicePasskey(fake.runtime))
      .toMatchObject({ ok: false, status: 0, error: 'gateway down', passkeysDisabled: false });
    expect(fake.register).not.toHaveBeenCalled();
  });
});

describe('classification helpers', () => {
  it('matches the server wording case-insensitively', () => {
    expect(isPasskeysDisabledText('Passkeys require UI password protection to be enabled')).toBe(true);
    expect(isPasskeysDisabledText('REQUIRE UI PASSWORD somewhere')).toBe(true);
    expect(isPasskeysDisabledText('No passkeys registered for this origin')).toBe(false);
    expect(isPasskeysDisabledText(undefined)).toBe(false);
  });

  it('derives passkeysDisabled from the body error when a body exists', () => {
    expect(actionFailure(400, 'transport failed', { error: 'Passkeys require UI password protection to be enabled' }))
      .toMatchObject({ ok: false, status: 400, error: 'transport failed', passkeysDisabled: true });
    expect(actionFailure(400, 'Passkeys require UI password protection to be enabled').passkeysDisabled).toBe(true);
    expect(actionFailure(500, 'boom').passkeysDisabled).toBe(false);
  });
});

describe('library face (§2.5)', () => {
  it('cancels through the abort service', () => {
    const fake = fakeRuntime();
    createPasskeyLibrary(fake.runtime).cancel();
    const cancel = fake.runtime.abortService.cancelCeremony as unknown as Mock;
    expect(cancel).toHaveBeenCalledTimes(1);
    cancelPasskeyCeremony(fake.runtime);
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it('exposes every documented operation', () => {
    const library = createPasskeyLibrary(createPasskeyRuntime());
    expect(Object.keys(library).sort()).toEqual([
      'cancel', 'list', 'login', 'register', 'resetAll', 'revoke', 'supportState',
    ]);
  });
});
