// SPDX-License-Identifier: Apache-2.0
/**
 * SessionAuthGate state helper (doc 08 §6.6). Pure-state tests, no DOM: every
 * branch below is a different operator situation that the component must be
 * able to distinguish, and each one is a real server answer verified against
 * `ui-auth.ts`, `routes/auth.ts`, and `rate-limit.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import {
  GATE_MAX_RETRIES,
  TRANSPORT_FAILURE_STATUS,
  classifySessionResponse,
  createSessionGateRuntime,
  formatRetryAfterLine,
  gateRetryDelayMs,
  loginWithPassword,
  parseLoginRateFields,
  probeSessionGate,
  probeSessionGateWithRetries,
  readJsonRecord,
  shouldAutoRetry,
} from '../sessionAuthGateState.ts';
import type { SessionGateRuntime } from '../sessionAuthGateState.ts';
import {
  TRUST_DEVICE_STORAGE_KEY,
  readTrustDevice,
  rememberTrustDevice,
} from '../sessionAuthGateTrust.ts';
import {
  gateIsOpen,
  sessionGateView,
  type PasskeySupportLike,
} from '../sessionAuthGateView.ts';
import { setRuntimeBearerToken } from '../runtime-auth.ts';
import { __resetAuthExpiryForTests, useAuthSessionStore } from '../runtime-auth-expiry.ts';

function jsonResponse(status: number, body?: unknown, headers?: Record<string, string>): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
  });
}

function htmlResponse(status: number): Response {
  return new Response('<!doctype html><html><body>Bad gateway</body></html>', {
    status,
    headers: { 'content-type': 'text/html' },
  });
}

/** Runtime over a queue of answers; `sleep` is free and counted. */
function gateRuntime(
  answers: Array<Response | Error>,
  overrides: Partial<SessionGateRuntime> = {},
): { runtime: SessionGateRuntime; calls: Array<{ url: string; init: RequestInit | undefined }>; sleeps: number[] } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const sleeps: number[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (next === undefined) throw new Error('gate test queue exhausted');
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as Mock;
  const runtime = createSessionGateRuntime({
    fetch: fetch as unknown as SessionGateRuntime['fetch'],
    storage: () => undefined,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    hasBearer: () => false,
    ...overrides,
  });
  return { runtime, calls, sleeps };
}

const SUPPORT = (level: PasskeySupportLike['level']): PasskeySupportLike => ({ level });
const PRESENT = { known: true, hasPasskeys: true, passkeysDisabled: false };
const ABSENT = { known: true, hasPasskeys: false, passkeysDisabled: false };
const UNKNOWN = { known: false, hasPasskeys: false, passkeysDisabled: false };

beforeEach(() => {
  __resetAuthExpiryForTests();
  setRuntimeBearerToken(null);
});

afterEach(() => {
  setRuntimeBearerToken(null);
});

// ---------------------------------------------------------------------------
// §6.6 step 1 — classification
// ---------------------------------------------------------------------------

describe('classifySessionResponse', () => {
  it('opens on the local-scope authenticated answer', () => {
    const probe = classifySessionResponse({
      status: 200,
      body: {
        authenticated: true,
        scope: 'session',
        authRequired: true,
        methods: ['password'],
        passkeys: false,
      },
    });
    expect(probe.stage).toBe('authenticated');
    expect(probe.authenticated).toBe(true);
    expect(probe.authRequired).toBe(true);
    expect(probe.scope).toBe('session');
    expect(probe.methods).toEqual(['password']);
    expect(gateIsOpen(probe)).toBe(true);
  });

  it('treats open mode as an open gate, not a stage of its own', () => {
    // ui-auth.ts answers `authenticated:true, scope:'open'` when no password
    // is configured, so no separate "open" stage is invented.
    const probe = classifySessionResponse({
      status: 200,
      body: { authenticated: true, scope: 'open', authRequired: false, methods: [] },
    });
    expect(probe.stage).toBe('authenticated');
    expect(probe.authRequired).toBe(false);
  });

  it('reads a 401 with locked as locked', () => {
    const probe = classifySessionResponse({ status: 401, body: { authenticated: false, locked: true } });
    expect(probe.stage).toBe('locked');
    expect(probe.tunnelLocked).toBe(false);
  });

  it('reads the tunnel variant and keeps it distinct from a password lock', () => {
    const probe = classifySessionResponse({
      status: 401,
      body: { authenticated: false, locked: true, tunnelLocked: true },
    });
    expect(probe.stage).toBe('tunnel-locked');
    expect(probe.tunnelLocked).toBe(true);
  });

  it('reads 429 as rate-limited', () => {
    expect(classifySessionResponse({ status: 429, body: { error: 'Too many attempts.' } }).stage)
      .toBe('rate-limited');
  });

  it('refuses to invent an open gate from 200 without authenticated', () => {
    const probe = classifySessionResponse({ status: 200, body: { authRequired: false } });
    expect(probe.stage).toBe('error');
    expect(probe.authenticated).toBe(false);
  });

  it('calls an unreachable host an error, with the transport status', () => {
    const probe = classifySessionResponse({ status: TRANSPORT_FAILURE_STATUS });
    expect(probe.stage).toBe('error');
    expect(probe.status).toBe(0);
    expect(probe.detail).toContain('could not reach the host');
  });

  it('does not crash on an HTML body', async () => {
    expect(await readJsonRecord(htmlResponse(502))).toBeUndefined();
    const probe = classifySessionResponse({ status: 502, body: undefined });
    expect(probe.stage).toBe('error');
    expect(probe.detail).toContain('no JSON body');
  });
});

// ---------------------------------------------------------------------------
// §6.6 step 1 — bounded retries
// ---------------------------------------------------------------------------

describe('probeSessionGateWithRetries', () => {
  it('backs off 1.5 s x attempt and gives up after 4 retries', () => {
    expect(gateRetryDelayMs(0)).toBe(0);
    expect([1, 2, 3, 4].map(gateRetryDelayMs)).toEqual([1_500, 3_000, 4_500, 6_000]);
    expect(shouldAutoRetry(0, 3)).toBe(true);
    expect(shouldAutoRetry(503, 3)).toBe(true);
    expect(shouldAutoRetry(503, GATE_MAX_RETRIES)).toBe(false);
    expect(shouldAutoRetry(401, 0)).toBe(false);
    expect(shouldAutoRetry(429, 0)).toBe(false);
  });

  it('retries transport and 5xx then reports the first real answer', async () => {
    const { runtime, calls, sleeps } = gateRuntime([
      new Error('tunnel not up yet'),
      jsonResponse(503),
      jsonResponse(401, { authenticated: false, locked: true }),
    ]);
    const probe = await probeSessionGateWithRetries(runtime);
    expect(probe.stage).toBe('locked');
    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toBe('/auth/session');
    expect(sleeps).toEqual([1_500, 3_000]);
  });

  it('does not retry a lock', async () => {
    const { runtime, calls, sleeps } = gateRuntime([jsonResponse(401, { locked: true })]);
    await probeSessionGateWithRetries(runtime);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('surfaces a 429 with the server retry-after', async () => {
    const { runtime } = gateRuntime([jsonResponse(429, { error: 'Too many attempts.' }, { 'retry-after': '120' })]);
    const probe = await probeSessionGate(runtime);
    expect(probe.stage).toBe('rate-limited');
    expect(probe.retryAfterSeconds).toBe(120);
  });

  it('reports a transport failure as status 0 without throwing', async () => {
    const { runtime } = gateRuntime([new Error('ECONNREFUSED')]);
    const probe = await probeSessionGate(runtime);
    expect(probe.stage).toBe('error');
    expect(probe.status).toBe(0);
    expect(probe.detail).toContain('ECONNREFUSED');
  });
});

// ---------------------------------------------------------------------------
// §6.6 step 2/3 — login, limiter headers, trust device
// ---------------------------------------------------------------------------

describe('loginWithPassword', () => {
  it('posts the body and adopts a minted client token', async () => {
    const { runtime, calls } = gateRuntime([
      jsonResponse(200, { authenticated: true, scope: 'client', clientToken: 'client-tok-9' }),
    ]);
    const result = await loginWithPassword(runtime, {
      password: 'correct horse',
      trustDevice: false,
      issueClientToken: true,
      clientKind: 'mobile',
      dedupeKey: 'dk-1',
    });
    expect(result.ok).toBe(true);
    expect(result.clientToken).toBe('client-tok-9');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      password: 'correct horse',
      trustDevice: false,
      issueClientToken: true,
      clientKind: 'mobile',
      dedupeKey: 'dk-1',
    });
    expect(useAuthSessionStore.getState().status).toBe('ok');
  });

  it('reports a wrong password as a lock, not a generic error', async () => {
    const { runtime } = gateRuntime([jsonResponse(401, { authenticated: false, locked: true, error: 'Invalid password.' })]);
    const result = await loginWithPassword(runtime, { password: 'nope', trustDevice: false });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.locked).toBe(true);
    expect(result.error).toBe('Invalid password.');
  });

  it('leaves a confirmed expiry in place when the login fails', async () => {
    // §6.7: the banner may only disappear once a login really succeeded, so a
    // wrong password must not walk the shared store back to `ok`.
    useAuthSessionStore.getState().markExpired();
    const { runtime } = gateRuntime([jsonResponse(401, { authenticated: false, locked: true, error: 'Invalid password.' })]);
    const result = await loginWithPassword(runtime, { password: 'nope', trustDevice: false });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.locked).toBe(true);
    expect(result.error).toBe('Invalid password.');
    expect(useAuthSessionStore.getState().status).toBe('expired');
  });

  it('marks the lock when the limiter says 429', async () => {
    const { runtime } = gateRuntime([
      jsonResponse(429, { error: 'Too many attempts.' }, { 'retry-after': '90', 'x-ratelimit-reset': '9999999999' }),
    ]);
    const result = await loginWithPassword(runtime, { password: 'nope', trustDevice: false });
    expect(result.locked).toBe(true);
    expect(result.retryAfterSeconds).toBe(90);
  });

  it('keeps the tunnel refusal distinct', async () => {
    const { runtime } = gateRuntime([jsonResponse(403, { error: 'Password login is not available over the tunnel.', tunnelLocked: true })]);
    const result = await loginWithPassword(runtime, { password: 'nope', trustDevice: false });
    expect(result.ok).toBe(false);
    expect(result.tunnelLocked).toBe(true);
    expect(result.locked).toBe(false);
  });

  it('never marks the session ok on a failure', async () => {
    useAuthSessionStore.getState().markExpired();
    const { runtime } = gateRuntime([jsonResponse(500, { error: 'boom' })]);
    const result = await loginWithPassword(runtime, { password: 'x', trustDevice: false });
    expect(result.ok).toBe(false);
    expect(useAuthSessionStore.getState().status).toBe('expired');
  });
});

describe('limiter headers', () => {
  it('parses both seconds fields and rejects garbage', () => {
    const ok = parseLoginRateFields(new Headers({ 'retry-after': '45', 'x-ratelimit-reset': '1700000000' }));
    expect(ok).toEqual({ retryAfterSeconds: 45, resetAtSeconds: 1_700_000_000 });
    const junk = parseLoginRateFields(new Headers({ 'retry-after': 'Wed, 21 Oct', 'x-ratelimit-reset': '-5' }));
    expect(junk).toEqual({ retryAfterSeconds: null, resetAtSeconds: null });
    expect(parseLoginRateFields(new Headers())).toEqual({ retryAfterSeconds: null, resetAtSeconds: null });
  });

  it('renders minutes and never invents a countdown', () => {
    expect(formatRetryAfterLine(120)).toContain('2 min');
    expect(formatRetryAfterLine(1)).toContain('1 min');
    expect(formatRetryAfterLine(null)).toContain('shortly');
  });
});

describe('trust this device', () => {
  function memoryStore(): { store: Record<string, string>; api: ReturnType<typeof createSessionGateRuntime>['storage'] } {
    const store: Record<string, string> = {};
    const api = () => ({
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
    });
    return { store, api };
  }

  it('round-trips the preference and clears it on false', () => {
    const { store, api } = memoryStore();
    const runtime = createSessionGateRuntime({ storage: api, hasBearer: () => false });
    rememberTrustDevice(runtime, true);
    expect(store[TRUST_DEVICE_STORAGE_KEY]).toBe('true');
    expect(readTrustDevice(runtime)).toBe(true);
    rememberTrustDevice(runtime, false);
    expect(store[TRUST_DEVICE_STORAGE_KEY]).toBeUndefined();
    expect(readTrustDevice(runtime)).toBe(false);
  });

  it('survives storage that throws and storage that is absent', () => {
    const throwing = createSessionGateRuntime({
      storage: () => ({
        getItem: () => {
          throw new Error('SecurityError');
        },
        setItem: () => {
          throw new Error('SecurityError');
        },
        removeItem: () => {
          throw new Error('SecurityError');
        },
      }),
      hasBearer: () => false,
    });
    expect(readTrustDevice(throwing)).toBe(false);
    expect(() => rememberTrustDevice(throwing, true)).not.toThrow();
    const missing = createSessionGateRuntime({ storage: () => undefined, hasBearer: () => false });
    expect(readTrustDevice(missing)).toBe(false);
    expect(() => rememberTrustDevice(missing, true)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// §6.6 step 6 — affordance mapping
// ---------------------------------------------------------------------------

describe('sessionGateView', () => {
  const locked = classifySessionResponse({ status: 401, body: { authenticated: false, locked: true, methods: ['password'] } });

  it('offers both routes when a passkey exists and the browser can use it', () => {
    const view = sessionGateView(locked, SUPPORT('available'), PRESENT);
    expect(view.passwordForm).toBe(true);
    expect(view.passkeyUnlock).toBe(true);
    expect(view.passkeyEnroll).toBe(false);
  });

  it('hides passkey unlock when the browser cannot, even if a passkey exists', () => {
    for (const level of ['unsupported', 'unavailable'] as const) {
      const view = sessionGateView(locked, SUPPORT(level), PRESENT);
      expect(view.passkeyUnlock).toBe(false);
      expect(view.passwordForm).toBe(true);
    }
  });

  it('does not claim "no passkeys" while the host is unreachable', () => {
    const view = sessionGateView(locked, SUPPORT('available'), UNKNOWN);
    expect(view.passkeyUnlock).toBe(false);
    expect(view.passkeyEnroll).toBe(false);
    expect(view.passwordForm).toBe(true);
  });

  it('offers enrollment only when the host confirmed the list is empty', () => {
    expect(sessionGateView(locked, SUPPORT('available'), ABSENT).passkeyEnroll).toBe(true);
  });

  it('shows the disabled hint without a passkey button', () => {
    const view = sessionGateView(locked, SUPPORT('available'), {
      known: false,
      hasPasskeys: false,
      passkeysDisabled: true,
    });
    expect(view.passkeysDisabledHint).toBe(true);
    expect(view.passkeyUnlock).toBe(false);
    expect(view.passkeyEnroll).toBe(false);
  });

  it('renders no credential field for the tunnel lock', () => {
    const probe = classifySessionResponse({
      status: 401,
      body: { authenticated: false, locked: true, tunnelLocked: true },
    });
    const view = sessionGateView(probe, SUPPORT('available'), PRESENT);
    expect(view.tunnelExplanation).toBe(true);
    expect(view.passwordForm).toBe(false);
    expect(view.passkeyUnlock).toBe(false);
    expect(view.retryable).toBe(true);
  });

  it('shows a retry line for the limiter and for errors', () => {
    const limited = { ...classifySessionResponse({ status: 429, body: {} }), retryAfterSeconds: 60 };
    expect(sessionGateView(limited, SUPPORT('unsupported'), UNKNOWN).retryLine).toContain('1 min');
    const errored = classifySessionResponse({ status: 502, body: undefined });
    const errorView = sessionGateView(errored, SUPPORT('unsupported'), UNKNOWN);
    expect(errorView.retryable).toBe(true);
    expect(errorView.retryLine).toContain('502');
  });

  it('renders nothing interactive once authenticated', () => {
    const probe = classifySessionResponse({ status: 200, body: { authenticated: true, scope: 'open', authRequired: false } });
    const view = sessionGateView(probe, SUPPORT('available'), PRESENT);
    expect(view).toMatchObject({
      stage: 'authenticated',
      passwordForm: false,
      passkeyUnlock: false,
      passkeyEnroll: false,
      tunnelExplanation: false,
      retryable: false,
    });
  });
});
