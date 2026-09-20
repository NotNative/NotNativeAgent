// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import {
  AUTH_SESSION_ENDPOINT,
  CONFIRM_PROBE_MIN_INTERVAL_MS,
  FOCUS_REVALIDATE_MIN_INTERVAL_MS,
  __resetAuthExpiryForTests,
  authSessionBlocksSend,
  createAuthExpiryRuntime,
  installAuthSessionFocusWatch,
  isClassifiableAuthPath,
  observeRuntimeAuthResponse,
  requestConfirmProbe,
  useAuthSessionStore,
} from '../runtime-auth-expiry.ts';
import type { AuthExpiryRuntime } from '../runtime-auth-expiry.ts';

/** Let every queued microtask settle. */
async function drain(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function fakeProbe(): {
  runtime: AuthExpiryRuntime;
  fetch: Mock;
  queue: Array<{ status: number } | Error>;
  advance: (ms: number) => void;
  now: () => number;
} {
  let clock = 1_000_000;
  const queue: Array<{ status: number } | Error> = [];
  const fetch = vi.fn(async () => {
    const next = queue.shift() ?? { status: 200 };
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify({ authenticated: next.status === 200 }), { status: next.status });
  }) as unknown as Mock;
  const runtime = createAuthExpiryRuntime({
    fetch: fetch as unknown as AuthExpiryRuntime['fetch'],
    now: () => clock,
    origin: () => 'http://runtime.test',
    document: () => undefined,
    window: () => undefined,
  });
  return {
    runtime,
    fetch,
    queue,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
}

function withDocument(runtime: AuthExpiryRuntime, doc: Document | undefined): AuthExpiryRuntime {
  return createAuthExpiryRuntime({ ...runtime, document: () => doc, window: () => undefined });
}

beforeEach(() => {
  __resetAuthExpiryForTests();
});

describe('401 classification (doc 08 §2.8)', () => {
  it('accepts /api and /auth traffic', () => {
    expect(isClassifiableAuthPath('/api/session')).toBe(true);
    expect(isClassifiableAuthPath('/auth/url-token')).toBe(true);
    expect(isClassifiableAuthPath('https://host.example/api/config?x=1')).toBe(true);
    expect(isClassifiableAuthPath('/api/session#frag')).toBe(true);
  });

  it('excludes the two normal-401 flows and the probe itself', () => {
    expect(isClassifiableAuthPath(AUTH_SESSION_ENDPOINT)).toBe(false);
    expect(isClassifiableAuthPath('/auth/session?probe=1')).toBe(false);
    expect(isClassifiableAuthPath('/api/client-auth/pairing/redeem')).toBe(false);
    expect(isClassifiableAuthPath('/api/client-auth')).toBe(false);
  });

  it('ignores anything outside the two prefixes', () => {
    expect(isClassifiableAuthPath('/health')).toBe(false);
    expect(isClassifiableAuthPath('/')).toBe(false);
    expect(isClassifiableAuthPath('')).toBe(false);
    expect(isClassifiableAuthPath('relative/thing')).toBe(false);
    expect(isClassifiableAuthPath('//cdn.example/api/x')).toBe(false);
  });
});

describe('observation and confirmation probe', () => {
  it('ignores non-401 responses entirely', () => {
    const probe = fakeProbe();
    observeRuntimeAuthResponse('/api/session', 200, probe.runtime);
    observeRuntimeAuthResponse('/api/session', 500, probe.runtime);
    expect(useAuthSessionStore.getState().lastSuspicionAt).toBeNull();
    expect(probe.fetch).not.toHaveBeenCalled();
  });

  it('ignores a 401 on a non-classifiable path', () => {
    const probe = fakeProbe();
    observeRuntimeAuthResponse('/health', 401, probe.runtime);
    expect(useAuthSessionStore.getState().lastSuspicionAt).toBeNull();
    expect(probe.fetch).not.toHaveBeenCalled();
  });

  it('ignores a 401 from a different origin (doc 08 §2.8)', () => {
    const probe = fakeProbe();
    observeRuntimeAuthResponse('https://other.example.test/api/session', 401, probe.runtime);
    expect(useAuthSessionStore.getState().lastSuspicionAt).toBeNull();
    expect(probe.fetch).not.toHaveBeenCalled();
  });

  it('accepts an absolute same-origin 401', async () => {
    const probe = fakeProbe();
    probe.queue.push({ status: 401 });
    observeRuntimeAuthResponse('http://runtime.test/api/session', 401, probe.runtime);
    await drain();
    expect(probe.fetch).toHaveBeenCalledTimes(1);
  });

  it('an unknown origin falls back to path-only classification', () => {
    const probe = fakeProbe();
    const runtime = createAuthExpiryRuntime({ ...probe.runtime, origin: () => null });
    observeRuntimeAuthResponse('/api/session', 401, runtime);
    expect(useAuthSessionStore.getState().lastSuspicionAt).not.toBeNull();
  });

  it('an origin that throws cannot arm the observer', () => {
    const probe = fakeProbe();
    const runtime = createAuthExpiryRuntime({
      ...probe.runtime,
      origin: () => {
        throw new Error('no location');
      },
    });
    observeRuntimeAuthResponse('/api/session', 401, runtime);
    expect(useAuthSessionStore.getState().lastSuspicionAt).not.toBeNull();
  });

  it('records the suspicion and confirms it with one probe', async () => {
    const probe = fakeProbe();
    probe.queue.push({ status: 401 });
    observeRuntimeAuthResponse('/api/session', 401, probe.runtime);
    expect(useAuthSessionStore.getState().lastSuspicionAt).toBe(1_000_000);
    await drain();
    expect(probe.fetch).toHaveBeenCalledTimes(1);
    expect(probe.fetch.mock.calls[0]?.[0]).toBe(AUTH_SESSION_ENDPOINT);
    expect(useAuthSessionStore.getState().status).toBe('expired');
    expect(useAuthSessionStore.getState().probing).toBe(false);
  });

  it('a 200 probe leaves an unaffected session alone', async () => {
    const probe = fakeProbe();
    probe.queue.push({ status: 200 });
    observeRuntimeAuthResponse('/api/config', 401, probe.runtime);
    await drain();
    expect(useAuthSessionStore.getState().status).toBe('ok');
  });

  it('a 200 probe revives only a session that had flipped', async () => {
    const probe = fakeProbe();
    probe.queue.push({ status: 401 }, { status: 200 });
    observeRuntimeAuthResponse('/api/session', 401, probe.runtime);
    await drain();
    expect(useAuthSessionStore.getState().status).toBe('expired');
    probe.advance(CONFIRM_PROBE_MIN_INTERVAL_MS + 1);
    expect(await requestConfirmProbe(probe.runtime)).toBe(true);
    await drain();
    expect(useAuthSessionStore.getState().status).toBe('ok');
  });

  it('throttles confirmation probes to one per 15 s window', async () => {
    const probe = fakeProbe();
    probe.queue.push({ status: 401 });
    observeRuntimeAuthResponse('/api/a', 401, probe.runtime);
    await drain();
    expect(probe.fetch).toHaveBeenCalledTimes(1);
    probe.advance(CONFIRM_PROBE_MIN_INTERVAL_MS - 1);
    observeRuntimeAuthResponse('/api/b', 401, probe.runtime);
    await drain();
    expect(probe.fetch).toHaveBeenCalledTimes(1);
    expect(useAuthSessionStore.getState().lastSuspicionAt).toBe(1_000_000 + CONFIRM_PROBE_MIN_INTERVAL_MS - 1);
    probe.advance(2);
    expect(await requestConfirmProbe(probe.runtime)).toBe(true);
    await drain();
    expect(probe.fetch).toHaveBeenCalledTimes(2);
  });

  it('joins an in-flight probe instead of duplicating it', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = vi.fn(async () => {
      await gate;
      return new Response('{}', { status: 401 });
    });
    const runtime = createAuthExpiryRuntime({
      fetch: fetch as unknown as AuthExpiryRuntime['fetch'],
      now: () => 5,
      document: () => undefined,
      window: () => undefined,
    });
    const first = requestConfirmProbe(runtime);
    const second = requestConfirmProbe(runtime);
    release?.();
    const [ranFirst, ranSecond] = await Promise.all([first, second]);
    await drain();
    expect(ranFirst).toBe(true);
    expect(ranSecond).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(useAuthSessionStore.getState().status).toBe('expired');
  });

  it('a transport failure proves nothing and changes no state', async () => {
    const probe = fakeProbe();
    probe.queue.push(new Error('socket died'));
    useAuthSessionStore.getState().markExpired();
    probe.advance(CONFIRM_PROBE_MIN_INTERVAL_MS + 1);
    expect(await requestConfirmProbe(probe.runtime)).toBe(true);
    await drain();
    expect(useAuthSessionStore.getState().status).toBe('expired');
    expect(useAuthSessionStore.getState().probing).toBe(false);
  });

  it('never overwrites an explicit reauthentication', async () => {
    const probe = fakeProbe();
    probe.queue.push({ status: 401 }, { status: 200 });
    useAuthSessionStore.getState().beginReauthentication();
    expect(await requestConfirmProbe(probe.runtime)).toBe(true);
    await drain();
    expect(useAuthSessionStore.getState().status).toBe('reauthenticating');
    probe.advance(CONFIRM_PROBE_MIN_INTERVAL_MS + 1);
    expect(await requestConfirmProbe(probe.runtime)).toBe(true);
    await drain();
    expect(useAuthSessionStore.getState().status).toBe('reauthenticating');
  });

  it('markOk and markExpired drive the state machine directly', () => {
    const store = useAuthSessionStore.getState();
    store.markExpired();
    expect(useAuthSessionStore.getState().status).toBe('expired');
    store.markOk();
    expect(useAuthSessionStore.getState().status).toBe('ok');
    store.beginReauthentication();
    expect(useAuthSessionStore.getState().status).toBe('reauthenticating');
  });
});

describe('focus revalidation (doc 08 §2.8)', () => {
  it('installs nothing when there is no document', () => {
    const probe = fakeProbe();
    const detach = installAuthSessionFocusWatch(probe.runtime);
    expect(typeof detach).toBe('function');
    detach();
    expect(probe.fetch).not.toHaveBeenCalled();
  });

  it('probes on wake and honours the five-minute throttle', async () => {
    const listeners = new Map<string, Array<() => void>>();
    const doc = {
      visibilityState: 'visible',
      addEventListener: (kind: string, handler: () => void) => {
        listeners.set(kind, [...(listeners.get(kind) ?? []), handler]);
      },
      removeEventListener: (kind: string, handler: () => void) => {
        listeners.set(kind, (listeners.get(kind) ?? []).filter((item) => item !== handler));
      },
    } as unknown as Document;
    const probe = fakeProbe();
    const detach = installAuthSessionFocusWatch(withDocument(probe.runtime, doc));
    const emit = (kind: string): void => {
      for (const handler of listeners.get(kind) ?? []) handler();
    };
    emit('visibilitychange');
    await drain();
    expect(probe.fetch).toHaveBeenCalledTimes(1);
    emit('focus');
    await drain();
    expect(probe.fetch).toHaveBeenCalledTimes(1);
    probe.advance(FOCUS_REVALIDATE_MIN_INTERVAL_MS - 1);
    emit('focus');
    await drain();
    expect(probe.fetch).toHaveBeenCalledTimes(1);
    probe.advance(FOCUS_REVALIDATE_MIN_INTERVAL_MS + 1);
    emit('focus');
    await drain();
    expect(probe.fetch).toHaveBeenCalledTimes(2);
    detach();
    expect(listeners.get('focus') ?? []).toHaveLength(0);
    expect(listeners.get('visibilitychange') ?? []).toHaveLength(0);
  });

  it('skips a hidden document', async () => {
    const handlers: Array<() => void> = [];
    const doc = {
      visibilityState: 'hidden',
      addEventListener: (_kind: string, handler: () => void) => {
        handlers.push(handler);
      },
      removeEventListener: () => undefined,
    } as unknown as Document;
    const probe = fakeProbe();
    installAuthSessionFocusWatch(withDocument(probe.runtime, doc));
    expect(handlers.length).toBe(2);
    for (const handler of handlers) handler();
    await drain();
    expect(probe.fetch).not.toHaveBeenCalled();
  });
});

describe('composer send guard (doc 08 §6.7 step 3)', () => {
  it('blocks only a confirmed expiry', () => {
    expect(authSessionBlocksSend('expired')).toBe(true);
    expect(authSessionBlocksSend('ok')).toBe(false);
    expect(authSessionBlocksSend('reauthenticating')).toBe(false);
  });
});
