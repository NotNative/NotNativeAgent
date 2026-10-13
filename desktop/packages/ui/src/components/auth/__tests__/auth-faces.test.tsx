// SPDX-License-Identifier: Apache-2.0
/**
 * @vitest-environment jsdom
 * SessionAuthGate and AuthExpiredBanner (doc 08 §6.6, §6.7). The gate is
 * mounted for real — its hooks, the shared session store, and the stage
 * mapping all run — and `runtimeFetch` is the one mocked seam, keyed by method
 * and pathname so each case reads as a server conversation instead of a
 * call-order script.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// runtimeFetch captures the native fetch at module load, so a global stub
// cannot reach it. This is the seam the other component tests in this package
// use: mock the module, then drive the mock.
vi.mock('../../../lib/runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));

import { runtimeFetch } from '../../../lib/runtime-fetch.ts';
import { SessionAuthGate } from '../SessionAuthGate.tsx';
import { AuthExpiredBanner } from '../AuthExpiredBanner.tsx';
import { createSessionGateRuntime, type SessionGateRuntime } from '../../../lib/sessionAuthGateState.ts';
import { setRuntimeBearerToken } from '../../../lib/runtime-auth.ts';
import {
  __resetAuthExpiryForTests,
  useAuthSessionStore,
} from '../../../lib/runtime-auth-expiry.ts';

const fetchMock = runtimeFetch as unknown as Mock;

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** Let every queued microtask and effect settle, inside act(). */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

function jsonResponse(status: number, body?: unknown, headers?: Record<string, string>): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const LOCKED = jsonResponse(401, { authenticated: false, locked: true });
const LIVE = jsonResponse(200, { authenticated: true, scope: 'session', authRequired: true, methods: ['password'] });
const OPEN = jsonResponse(200, { authenticated: true, scope: 'open', authRequired: false, methods: [] });
const PASSKEY_ROWS = jsonResponse(200, { passkeys: [{ id: 'pk_1', label: 'Phone key' }] });

type Route = { method: string; matches: RegExp; answers: Response[] };

/**
 * `runtimeFetch` answers keyed by method + path. Answers are consumed in order
 * per route and the last one repeats, so an unexpected extra poll behaves like
 * a real server rather than throwing.
 */
function stubFetch(routes: Route[]): { calls: Array<{ method: string; url: string; body: string }> } {
  const calls: Array<{ method: string; url: string; body: string }> = [];
  const taken = new Map<Route, number>();
  fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const path = new URL(url, 'http://localhost:3000').pathname;
    calls.push({ method, url, body: typeof init?.body === 'string' ? init.body : '' });
    const route = routes.find((entry) => entry.method === method && entry.matches.test(path));
    if (route === undefined) return new Response('not stubbed', { status: 500 });
    const index = Math.min(taken.get(route) ?? 0, route.answers.length - 1);
    taken.set(route, index + 1);
    // A Response body can only be read once, so every hand-back is a fresh
    // clone of the scripted answer; the last answer repeats for extra polls.
    const scripted = route.answers[index] ?? LOCKED;
    return scripted.clone();
  });
  return { calls };
}

function gateRuntime(): SessionGateRuntime {
  const store: Record<string, string> = {};
  return createSessionGateRuntime({
    storage: () => ({
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
    }),
    sleep: async () => undefined,
    hasBearer: () => false,
    secureContext: () => true,
    userAgent: () => 'test-agent',
    supportsWebAuthn: () => true,
    supportsPasskeys: async () => true,
    startRegistration: vi.fn() as never,
    startAuthentication: vi.fn() as never,
    abortService: { cancelCeremony: vi.fn() } as never,
  });
}

let root: Root | null = null;

async function mount(node: ReactElement): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(node);
  });
  await settle();
  return host;
}

function byTestId(host: HTMLElement, id: string): HTMLElement | null {
  return host.querySelector(`[data-testid="${id}"]`);
}

async function click(element: HTMLElement | null): Promise<void> {
  if (element === null) throw new Error('expected an element to click');
  await act(async () => {
    element.click();
  });
  await settle();
}

async function typePassword(host: HTMLElement, value: string): Promise<void> {
  const input = byTestId(host, 'gate-password') as HTMLInputElement | null;
  if (input === null) throw new Error('no password field rendered');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  __resetAuthExpiryForTests();
  setRuntimeBearerToken(null);
});

afterEach(() => {
  act(() => {
    root?.unmount();
    root = null;
  });
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

// ---------------------------------------------------------------------------
// §6.6 — the gate
// ---------------------------------------------------------------------------

describe('SessionAuthGate', () => {
  it('shows the locked form instead of the app, then reveals the app on a live session', async () => {
    const fetcher = stubFetch([
      { method: 'GET', matches: /^\/auth\/session$/, answers: [LOCKED, LIVE] },
      { method: 'POST', matches: /^\/auth\/session$/, answers: [LIVE] },
    ]);
    const host = await mount(
      <SessionAuthGate runtime={gateRuntime()}>
        <p>the app</p>
      </SessionAuthGate>,
    );
    expect(byTestId(host, 'session-auth-gate')).not.toBeNull();
    expect(host.textContent).not.toContain('the app');
    expect(byTestId(host, 'gate-password')).not.toBeNull();

    await typePassword(host, 'hunter2');
    await click(byTestId(host, 'gate-submit'));

    expect(byTestId(host, 'session-auth-gate')).toBeNull();
    expect(host.textContent).toContain('the app');
    const posted = fetcher.calls.find((call) => call.method === 'POST');
    expect(posted?.body).toContain('hunter2');
  });

  it('renders the app immediately when the session is already live', async () => {
    const fetcher = stubFetch([{ method: 'GET', matches: /^\/auth\/session$/, answers: [LIVE] }]);
    const host = await mount(
      <SessionAuthGate runtime={gateRuntime()}>
        <p>the app</p>
      </SessionAuthGate>,
    );
    expect(host.textContent).toContain('the app');
    expect(byTestId(host, 'session-auth-gate')).toBeNull();
  });

  it('renders the app with no probe at all when auth is skipped (§6.6 VS Code)', async () => {
    const fetcher = stubFetch([]);
    const host = await mount(
      <SessionAuthGate skipAuth runtime={gateRuntime()}>
        <p>the app</p>
      </SessionAuthGate>,
    );
    expect(host.textContent).toContain('the app');
    expect(fetcher.calls).toHaveLength(0);
  });

  it('reports a rejected password without losing the form', async () => {
    const fetcher = stubFetch([
      { method: 'GET', matches: /^\/auth\/session$/, answers: [LOCKED] },
      { method: 'POST', matches: /^\/auth\/session$/, answers: [jsonResponse(401, { error: 'Invalid password.' })] },
    ]);
    const host = await mount(
      <SessionAuthGate runtime={gateRuntime()}>
        <p>the app</p>
      </SessionAuthGate>,
    );
    await typePassword(host, 'wrong');
    await click(byTestId(host, 'gate-submit'));
    expect(byTestId(host, 'gate-error')?.textContent).toContain('Invalid password.');
    expect(host.textContent).not.toContain('the app');
    expect(byTestId(host, 'gate-password')).not.toBeNull();
  });

  it('shows the limiter window and refuses a password form while rate limited', async () => {
    const fetcher = stubFetch([
      {
        method: 'GET',
        matches: /^\/auth\/session$/,
        answers: [jsonResponse(429, { error: 'Too many attempts.' }, { 'retry-after': '120' })],
      },
    ]);
    const host = await mount(
      <SessionAuthGate runtime={gateRuntime()}>
        <p>the app</p>
      </SessionAuthGate>,
    );
    expect(byTestId(host, 'session-auth-gate')?.getAttribute('data-stage')).toBe('rate-limited');
    expect(byTestId(host, 'gate-password')).toBeNull();
    expect(byTestId(host, 'gate-retry')?.textContent).toContain('2 min');
  });

  it('explains the tunnel lock and renders no credential field (§2.9)', async () => {
    const fetcher = stubFetch([
      {
        method: 'GET',
        matches: /^\/auth\/session$/,
        answers: [jsonResponse(401, { authenticated: false, locked: true, tunnelLocked: true })],
      },
    ]);
    const host = await mount(
      <SessionAuthGate runtime={gateRuntime()}>
        <p>the app</p>
      </SessionAuthGate>,
    );
    expect(byTestId(host, 'session-auth-gate')?.getAttribute('data-stage')).toBe('tunnel-locked');
    expect(byTestId(host, 'gate-tunnel-note')).not.toBeNull();
    expect(byTestId(host, 'gate-password')).toBeNull();
    expect(byTestId(host, 'gate-submit')).toBeNull();
  });

  it('does not offer a passkey button while the host is locked, even with support', async () => {
    // §6.6 step 2: `hasPasskeys` needs `GET /api/passkeys`, which answers 401
    // for a locked visitor, so presence is unknown and the button is withheld.
    const fetcher = stubFetch([
      { method: 'GET', matches: /^\/auth\/session$/, answers: [LOCKED] },
      { method: 'GET', matches: /^\/api\/passkeys$/, answers: [jsonResponse(401, { error: 'Unauthorized' })] },
    ]);
    const host = await mount(
      <SessionAuthGate runtime={gateRuntime()}>
        <p>the app</p>
      </SessionAuthGate>,
    );
    expect(byTestId(host, 'gate-passkey')).toBeNull();
    expect(byTestId(host, 'gate-password')).not.toBeNull();
  });

  it('re-enters the gate from the banner and clears the store when the session is alive again', async () => {
    const fetcher = stubFetch([{ method: 'GET', matches: /^\/auth\/session$/, answers: [LOCKED, LIVE] }]);
    const host = await mount(
      <SessionAuthGate runtime={gateRuntime()}>
        <p>the app</p>
      </SessionAuthGate>,
    );
    expect(host.textContent).not.toContain('the app');
    act(() => {
      useAuthSessionStore.getState().beginReauthentication();
    });
    await settle();
    expect(host.textContent).toContain('the app');
    expect(useAuthSessionStore.getState().status).toBe('ok');
  });

  it('a tunnel-locked re-entry is not a successful login: no password form, store stays reauthenticating', async () => {
    // §6.6 step 5 marks the shared store ok only on a live session. A tunnel
    // lock (§2.9) has no password route at all, so the §6.7 "Log in" click
    // must land in the no-credential tunnel screen and leave the §6.7 store
    // exactly where the banner put it.
    const fetcher = stubFetch([
      {
        method: 'GET',
        matches: /^\/auth\/session$/,
        answers: [
          LOCKED,
          jsonResponse(401, { authenticated: false, locked: true, tunnelLocked: true }),
        ],
      },
    ]);
    const host = await mount(
      <SessionAuthGate runtime={gateRuntime()}>
        <p>the app</p>
      </SessionAuthGate>,
    );
    expect(byTestId(host, 'gate-password')).not.toBeNull();
    act(() => {
      useAuthSessionStore.getState().beginReauthentication();
    });
    await settle();
    expect(byTestId(host, 'session-auth-gate')?.getAttribute('data-stage')).toBe('tunnel-locked');
    expect(byTestId(host, 'gate-password')).toBeNull();
    expect(byTestId(host, 'gate-submit')).toBeNull();
    expect(useAuthSessionStore.getState().status).toBe('reauthenticating');
    // The response the re-entry consumed is the tunnel answer, not a repost.
    expect(fetcher.calls.filter((call) => call.method === 'GET')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// §6.7 — the banner
// ---------------------------------------------------------------------------

describe('AuthExpiredBanner', () => {
  it('stays hidden while the session is believed alive', () => {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => {
      root?.render(<AuthExpiredBanner />);
    });
    expect(host.textContent).toBe('');
  });

  it('appears on a confirmed expiry and hands off to the gate on click', async () => {
    useAuthSessionStore.getState().markExpired();
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    let begun = 0;
    await act(async () => {
      root?.render(<AuthExpiredBanner onBeginLogin={() => { begun += 1; }} />);
    });
    const banner = host.querySelector('[role="status"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('Session expired');

    await click(banner?.querySelector('button') ?? null);
    expect(begun).toBe(1);
    expect(useAuthSessionStore.getState().status).toBe('reauthenticating');
    expect(host.textContent).toBe('');
  });

  it('leaves when a later login succeeds', async () => {
    useAuthSessionStore.getState().markExpired();
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<AuthExpiredBanner />);
    });
    expect(host.textContent).toContain('Session expired');
    act(() => {
      useAuthSessionStore.getState().markOk();
    });
    await settle();
    expect(host.textContent).toBe('');
  });

  it('can be pinned to other states by its host', () => {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => {
      root?.render(<AuthExpiredBanner readState={() => 'reauthenticating'} visibleIn={['reauthenticating']} label={{ title: 'Logging in' }} />);
    });
    expect(host.textContent).toContain('Logging in');
  });
});
