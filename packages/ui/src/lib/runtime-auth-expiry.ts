// SPDX-License-Identifier: Apache-2.0
/**
 * Auth expiry detection (doc 08 §2.8). Nothing polls: every `runtimeFetch`
 * response is observed, a *classifiable* 401 raises suspicion, and each
 * suspicion is confirmed by exactly one debounced `GET /auth/session` probe
 * that re-enters `runtimeFetch`.
 *
 * A 401 alone is not proof — a proxied provider error (a dead Anthropic
 * key) also surfaces as 401 — so `expired` is only ever reached through the
 * probe. The probe targets `/auth/session`, which is excluded from
 * classification, so a confirmed expiry can never re-arm the observer.
 */
import { create } from 'zustand';
import { runtimeFetch } from './runtime-fetch.ts';
import { getApiBaseUrl } from './runtime-url.ts';

export type AuthSessionState = 'ok' | 'expired' | 'reauthenticating';

/**
 * §6.7 step 3: the composer send guard. Only a confirmed expiry blocks sends;
 * `reauthenticating` keeps the app usable while the gate re-checks in the
 * background, and a transport failure never blocks (that is connectivity).
 */
export function authSessionBlocksSend(status: AuthSessionState): boolean {
  return status === 'expired';
}

/** §2.8: one confirmation probe per window, one in flight at a time. */
export const CONFIRM_PROBE_MIN_INTERVAL_MS = 15_000;
/** §2.8: focus revalidation throttle ("laptop woke up, first click fails"). */
export const FOCUS_REVALIDATE_MIN_INTERVAL_MS = 5 * 60_000;
export const AUTH_SESSION_ENDPOINT = '/auth/session';

export interface AuthSessionStore {
  status: AuthSessionState;
  /** Wall time of the last accepted 401 suspicion. */
  lastSuspicionAt: number | null;
  /** Wall time of the last probe that actually went out. */
  lastProbeAt: number | null;
  /** True while a probe is in flight. */
  probing: boolean;
  /** Set by the banner's explicit "Log in" click (§2.8 consumers). */
  beginReauthentication: () => void;
  markExpired: () => void;
  markOk: () => void;
}

export const useAuthSessionStore = create<AuthSessionStore>()((set) => ({
  status: 'ok',
  lastSuspicionAt: null,
  lastProbeAt: null,
  probing: false,
  beginReauthentication: () => set({ status: 'reauthenticating' }),
  markExpired: () => set({ status: 'expired' }),
  markOk: () => set({ status: 'ok' }),
}));

export interface AuthExpiryRuntime {
  fetch: typeof runtimeFetch;
  now(): number;
  /**
   * Origin relative requests resolve against — the configured API base when
   * there is one, otherwise the document origin. `null` means unknown and
   * turns the same-origin narrowing off rather than guessing.
   */
  origin(): string | null;
  /** Listeners for focus revalidation; absent in a node test environment. */
  document(): Document | undefined;
  window(): Window | undefined;
}

export function createAuthExpiryRuntime(
  overrides: Partial<AuthExpiryRuntime> = {},
): AuthExpiryRuntime {
  const base: AuthExpiryRuntime = {
    // Deferred on purpose: runtime-fetch observes responses here, so the
    // module import is cyclic and the binding must not be read at eval time.
    fetch: (input, init) => runtimeFetch(input, init),
    now: () => Date.now(),
    origin: () => originOfBaseUrl(getApiBaseUrl()),
    document: () => (globalThis as { document?: Document }).document,
    window: () => (globalThis as { window?: Window }).window,
  };
  return { ...base, ...overrides };
}

/** Origin of an absolute base URL; null for '' or a non-URL value. */
function originOfBaseUrl(base: string): string | null {
  try {
    return base === '' ? null : new URL(base).origin;
  } catch {
    return null;
  }
}

/**
 * §2.8 classifier. Only `/api/…` and `/auth/…` are classifiable, minus the
 * two known-normal 401 flows: the password check on `/auth/session` itself
 * and the pairing redeem under `/api/client-auth/…` (also the probe, which
 * is why a confirmed expiry cannot loop).
 */
export function isClassifiableAuthPath(url: string, origin?: string | null): boolean {
  const path = pathOf(url);
  if (path === null) return false;
  // Cross-origin 401s are somebody else's auth problem. Only a same-origin
  // response can say anything about *our* session (§2.8).
  if (origin !== undefined && origin !== null && !isSameOrigin(url, origin)) return false;
  if (path === AUTH_SESSION_ENDPOINT || path.startsWith(`${AUTH_SESSION_ENDPOINT}/`)) return false;
  if (path === '/api/client-auth' || path.startsWith('/api/client-auth/')) return false;
  return path.startsWith('/api/') || path.startsWith('/auth/');
}

/**
 * Origin equality resolved against the effective base: a relative path belongs
 * to that base, a protocol-relative or absolute URL must match it exactly. An
 * unparsable pair is never a match.
 */
function isSameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url, origin).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

/** Path with origin, query, and hash removed; null for a non-URL input. */
function pathOf(url: string): string | null {
  const value = String(url ?? '').trim();
  if (value === '') return null;
  // A protocol-relative URL names a host we cannot resolve without a base, so
  // it is never assumed to be ours.
  if (value.startsWith('//')) return null;
  const withoutScheme = /^https?:\/\//iu.test(value) ? value.replace(/^https?:\/\/[^/]*/iu, '') : value;
  const cut = firstIndexOf(withoutScheme, ['?', '#']);
  const path = cut === -1 ? withoutScheme : withoutScheme.slice(0, cut);
  if (path === '') return '/';
  return path.startsWith('/') ? path : null;
}

function firstIndexOf(value: string, needles: string[]): number {
  let best = -1;
  for (const needle of needles) {
    const at = value.indexOf(needle);
    if (at !== -1 && (best === -1 || at < best)) best = at;
  }
  return best;
}

/**
 * `runtimeFetch` calls this for every response. Only a 401 can raise
 * suspicion, and suspicion is never proof on its own (§2.8).
 */
export function observeRuntimeAuthResponse(
  url: string,
  status: number,
  runtime: AuthExpiryRuntime = defaultRuntime,
): void {
  if (status !== 401) return;
  if (!isClassifiableAuthPath(url, effectiveOrigin(runtime))) return;
  useAuthSessionStore.setState({ lastSuspicionAt: runtime.now() });
  void requestConfirmProbe(runtime, CONFIRM_PROBE_MIN_INTERVAL_MS);
}

/** Origin used for the same-origin narrowing; unknown reads as "no filter". */
function effectiveOrigin(runtime: AuthExpiryRuntime): string | null {
  try {
    return runtime.origin();
  } catch {
    return null;
  }
}

let inFlight: Promise<boolean> | null = null;

/**
 * One debounced confirmation probe. Returns whether a probe ran. The
 * single-flight guard and the window throttle are independent: an in-flight
 * probe is joined, never duplicated.
 */
export async function requestConfirmProbe(
  runtime: AuthExpiryRuntime = defaultRuntime,
  minIntervalMs: number = CONFIRM_PROBE_MIN_INTERVAL_MS,
): Promise<boolean> {
  if (inFlight !== null) {
    await inFlight;
    return false;
  }
  const now = runtime.now();
  const last = useAuthSessionStore.getState().lastProbeAt;
  if (last !== null && now - last < minIntervalMs) return false;
  inFlight = runProbe(runtime, now).finally(() => {
    inFlight = null;
  });
  return (await inFlight) === true;
}

async function runProbe(runtime: AuthExpiryRuntime, startedAt: number): Promise<boolean> {
  useAuthSessionStore.setState({ probing: true, lastProbeAt: startedAt });
  try {
    // Rides runtimeFetch on purpose: the probe must see the same auth
    // headers, relay routing, and 401 handling as any other call (§2.8).
    const response = await runtime.fetch(AUTH_SESSION_ENDPOINT, { method: 'GET' });
    applyProbeOutcome(response.status);
    return true;
  } catch {
    // A transport failure proves nothing about the session; keep the state.
    return true;
  } finally {
    useAuthSessionStore.setState({ probing: false });
  }
}

/** §2.8: 401 → expired; 200 → back to ok only if a probe had flipped us. */
function applyProbeOutcome(status: number): void {
  const state = useAuthSessionStore.getState();
  if (status === 401) {
    if (state.status !== 'reauthenticating') state.markExpired();
    return;
  }
  if (status >= 200 && status < 300 && state.status === 'expired') state.markOk();
}

/** Focus revalidation (§2.8). Returns the detach function. */
export function installAuthSessionFocusWatch(
  runtime: AuthExpiryRuntime = defaultRuntime,
): () => void {
  const target = watchTarget(runtime);
  if (target === undefined) return () => undefined;
  let lastFocusProbeAt: number | null = null;
  const onWakeup = (): void => {
    if (!documentVisible(runtime)) return;
    const now = runtime.now();
    if (lastFocusProbeAt !== null && now - lastFocusProbeAt < FOCUS_REVALIDATE_MIN_INTERVAL_MS) return;
    lastFocusProbeAt = now;
    void requestConfirmProbe(runtime, 0);
  };
  target.addEventListener('visibilitychange', onWakeup);
  target.addEventListener('focus', onWakeup);
  return () => {
    target.removeEventListener('visibilitychange', onWakeup);
    target.removeEventListener('focus', onWakeup);
  };
}

function watchTarget(runtime: AuthExpiryRuntime): Document | undefined {
  const doc = runtime.document();
  return doc !== undefined && typeof doc.addEventListener === 'function' ? doc : undefined;
}

function documentVisible(runtime: AuthExpiryRuntime): boolean {
  const doc = runtime.document();
  return doc === undefined || doc.visibilityState !== 'hidden';
}

/** Test seam: forget the single-flight probe so cases cannot leak. */
export function __resetAuthExpiryForTests(): void {
  inFlight = null;
  useAuthSessionStore.setState({
    status: 'ok',
    lastSuspicionAt: null,
    lastProbeAt: null,
    probing: false,
  });
}

const defaultRuntime = createAuthExpiryRuntime();
