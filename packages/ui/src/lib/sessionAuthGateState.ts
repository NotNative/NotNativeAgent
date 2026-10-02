// SPDX-License-Identifier: Apache-2.0
/**
 * SessionAuthGate state helper (doc 08 §6.6). Spec-named file; the component
 * in `components/auth/` stays presentational and renders from this output, so
 * the distinction between the four locked-ish situations is unit-testable
 * without a DOM.
 *
 * Stages are exactly §6.6: `pending -> authenticated | locked | error |
 * rate-limited`, plus the `tunnelLocked` payload variant that renders *no*
 * password field (§2.9/E-08-17: password login is hard-403ed at tunnel scope).
 *
 * Verified server shapes this mirrors:
 * - local scope (ui-auth.ts `sessionStatus`): `200 {authenticated:true, scope,
 *   authRequired, methods:['password'], passkeys:false}` or `401
 *   {authenticated:false, locked:true}`.
 * - tunnel scope (routes/auth.ts `tunnelSessionStatus`): `200 {authenticated:
 *   true, scope:'tunnel'|'client'}` or `401 {authenticated:false, locked:true,
 *   tunnelLocked:true}`.
 * - `429` from the login limiter carries `retry-after` (seconds) and
 *   `x-ratelimit-reset` (epoch seconds) (rate-limit.ts `rateLimitHeaders`).
 *
 * Two deliberate refusals:
 * - No invented `200 {authenticated:false}` "open mode" stage. Open mode
 *   answers `authenticated:true, scope:'open'` (ui-auth.ts:213), so the gate
 *   simply opens; a `200` without `authenticated:true` is `error`, not a lock.
 * - `hasPasskeys` is not on `/auth/session`. The server refuses
 *   `/auth/passkey/authenticate/options` with `400 No passkeys registered for
 *   this origin` when the list is empty (ui-passkeys.ts:252), and the list
 *   endpoint needs a session. So a locked visitor cannot learn whether a
 *   passkey exists; presence is read only once the session is live, and
 *   reported as unknown (`known:false`) rather than guessed as false.
 */
import { getInjectedClientToken } from './runtimeConfig.ts';
import { setRuntimeBearerToken } from './runtime-auth.ts';
import { useAuthSessionStore } from './runtime-auth-expiry.ts';
import {
  createPasskeyRuntime,
  type PasskeyRuntime,
} from './passkeys-support.ts';
import { rememberTrustDevice } from './sessionAuthGateTrust.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** §6.6 step 1: up to 4 bounded auto-retries on network / 5xx. */
export const GATE_MAX_RETRIES = 4;
/** §6.6 step 1: 1.5 s x attempt. */
export const GATE_RETRY_BASE_MS = 1_500;
/**
 * §6.6 step 2: the checkbox is a browser preference; the TTL is the server's.
 * Defined in the `sessionAuthGateTrust.ts` leaf and re-exported here so callers
 * have a single entry point for gate state.
 */
export { TRUST_DEVICE_STORAGE_KEY } from './sessionAuthGateTrust.ts';

export const SESSION_ENDPOINT = '/auth/session';

/** A transport failure reports this synthetic status; it is not an HTTP code. */
export const TRANSPORT_FAILURE_STATUS = 0;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GateStage =
  | 'pending'
  | 'authenticated'
  | 'locked'
  | 'tunnel-locked'
  | 'error'
  | 'rate-limited';

export interface SessionProbe {
  stage: GateStage;
  /** HTTP status, or 0 for a transport failure. */
  status: number;
  authenticated: boolean;
  /** `authRequired` exactly as answered; false when the host said so. */
  authRequired: boolean;
  /** `scope` as answered: open | session | client | tunnel. */
  scope?: string;
  methods: string[];
  /** `tunnelLocked` from the payload (§2.9). */
  tunnelLocked: boolean;
  /** Server `error` text when the answer carried one. */
  error?: string;
  /** `429` only: seconds from `retry-after`, when the server said. */
  retryAfterSeconds: number | null;
  /** Diagnostics only; never a secret. */
  detail?: string;
}

export interface PasswordLoginResult {
  ok: boolean;
  status: number;
  error?: string;
  locked: boolean;
  tunnelLocked: boolean;
  retryAfterSeconds: number | null;
  /** Minted device token when the caller asked for one (§6.6 step 3). */
  clientToken: string | null;
}

export interface LoginRequestBody {
  password: string;
  trustDevice: boolean;
  issueClientToken?: boolean;
  clientKind?: string;
  dedupeKey?: string;
}

export interface PasskeyPresence {
  /** False means the answer was not obtainable (locked / unreachable). */
  known: boolean;
  hasPasskeys: boolean;
  passkeysDisabled: boolean;
  rpID?: string;
}

export interface SessionGateView {
  stage: GateStage;
  authRequired: boolean;
  passwordForm: boolean;
  nativeBootstrapForm: boolean;
  passkeyUnlock: boolean;
  passkeyEnroll: boolean;
  passkeysDisabledHint: boolean;
  tunnelExplanation: boolean;
  retryable: boolean;
  /** Rendered on the rate-limited screen (§6.6: minutes). */
  retryLine: string | null;
}

/** Storage seam: `localStorage` in the browser, absent under node. */
export interface SimpleStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SessionGateRuntime extends PasskeyRuntime {
  /** Trust-device persistence; undefined when storage is unavailable. */
  storage(): SimpleStore | undefined;
  /** Retry clock; tests replace it so a 4-retry run costs nothing. */
  sleep(ms: number): Promise<void>;
  /** Bearer presence probe; overridable so tests need no injection globals. */
  hasBearer(): boolean;
}

export function createSessionGateRuntime(
  overrides: Partial<SessionGateRuntime> = {},
): SessionGateRuntime {
  const base: SessionGateRuntime = {
    ...createPasskeyRuntime(),
    storage: readLocalStorage,
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    // Honest answer from the real header builder's own input: the bearer is
    // private in runtime-auth.ts, so the only public question is "would an
    // Authorization header be applied?", which is the same question (§6.6
    // step 1 distinguishes `unauthenticated` from `locked`).
    hasBearer: () => getInjectedClientToken() !== undefined,
  };
  return { ...base, ...overrides };
}

function readLocalStorage(): SimpleStore | undefined {
  const scope = globalThis as { localStorage?: SimpleStore };
  const store = scope.localStorage;
  if (store === undefined || typeof store.getItem !== 'function') return undefined;
  return store;
}

// ---------------------------------------------------------------------------
// Retry arithmetic
// ---------------------------------------------------------------------------

/**
 * `1.5 s x attempt` for attempt 1..4 => 1500, 3000, 4500, 6000. A 0th attempt
 * (the first try) never sleeps.
 */
export function gateRetryDelayMs(attempt: number): number {
  if (attempt <= 0) return 0;
  return GATE_RETRY_BASE_MS * attempt;
}

/** Network failure or 5xx only; 4xx is an answer, not a retry. */
export function shouldAutoRetry(status: number, attempt: number): boolean {
  if (attempt >= GATE_MAX_RETRIES) return false;
  if (status === TRANSPORT_FAILURE_STATUS) return true;
  return status >= 500 && status <= 599;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

export interface LoginRateFields {
  retryAfterSeconds: number | null;
  resetAtSeconds: number | null;
}

/** `retry-after` (seconds) + `x-ratelimit-reset` (epoch seconds), both optional. */
export function parseLoginRateFields(headers: Headers): LoginRateFields {
  return {
    retryAfterSeconds: parseSeconds(headers.get('retry-after'), false),
    resetAtSeconds: parseSeconds(headers.get('x-ratelimit-reset'), true),
  };
}

function parseSeconds(raw: string | null, mustBePositive: boolean): number | null {
  if (raw === null) return null;
  const value = Number(raw.trim());
  if (!Number.isFinite(value)) return null;
  if (mustBePositive ? value <= 0 : value < 0) return null;
  return Math.floor(value);
}

/**
 * §6.6 renders Retry-After in minutes. A missing header degrades to a
 * "shortly" line instead of inventing a countdown the server never gave.
 */
export function formatRetryAfterLine(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return 'Too many attempts. Try again shortly.';
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return 'Too many attempts. Try again in ' + minutes + ' min.';
}

function readMethods(body: Record<string, unknown> | undefined): string[] {
  const raw = body?.methods;
  if (Array.isArray(raw) === false) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string');
}

function readError(body: Record<string, unknown> | undefined): string | undefined {
  const text = body?.error;
  return typeof text === 'string' && text !== '' ? text : undefined;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * The whole gate decision, as a pure function of the response. Every branch is
 * a different operator situation and none of them are merged.
 */
export function classifySessionResponse(input: {
  status: number;
  body?: Record<string, unknown>;
}): SessionProbe {
  const base = {
    status: input.status,
    authenticated: false,
    authRequired: true,
    methods: readMethods(input.body),
    tunnelLocked: input.body?.tunnelLocked === true,
    error: readError(input.body),
    retryAfterSeconds: null as number | null,
  };
  const body = input.body;

  if (input.status === TRANSPORT_FAILURE_STATUS) {
    return { ...base, stage: 'error', detail: 'session probe could not reach the host' };
  }
  if (input.status === 429) {
    // The stage itself carries "locked by the limiter"; `retryAfterSeconds` is
    // filled by the caller that still has the response headers.
    return { ...base, stage: 'rate-limited' };
  }
  if (body === undefined) {
    // The status is included because this is the branch an operator sees when
    // a proxy answers an API route with an HTML error page: the code is the
    // only usable clue.
    return { ...base, stage: 'error', detail: 'session probe returned no JSON body (' + String(input.status) + ')' };
  }
  if (body.authenticated === true) {
    const scope = typeof body.scope === 'string' ? body.scope : undefined;
    return {
      ...base,
      stage: 'authenticated',
      authenticated: true,
      authRequired: body.authRequired === true,
      scope,
      tunnelLocked: false,
      error: undefined,
    };
  }
  if (body.tunnelLocked === true) {
    return { ...base, stage: 'tunnel-locked', authRequired: body.authRequired === true };
  }
  if (body.locked === true || input.status === 401) {
    return { ...base, stage: 'locked' };
  }
  return {
    ...base,
    stage: 'error',
    authRequired: body.authRequired === true,
    detail: 'unexpected session answer (' + String(input.status) + ')',
  };
}

/** Reads a JSON body defensively: an HTML error page must not crash the gate. */
export async function readJsonRecord(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = await response.json();
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

/** One `GET /auth/session`; relative so runtimeFetch resolves + observes it. */
export async function probeSessionGate(
  runtime: SessionGateRuntime,
): Promise<SessionProbe> {
  let response: Response;
  try {
    response = await runtime.fetch(SESSION_ENDPOINT, { method: 'GET' });
  } catch (error) {
    return {
      ...classifySessionResponse({ status: TRANSPORT_FAILURE_STATUS }),
      detail: classifySessionResponse({ status: TRANSPORT_FAILURE_STATUS }).detail
        + ' (' + String(error instanceof Error ? error.message : error) + ')',
    };
  }
  const body = await readJsonRecord(response);
  const probe = classifySessionResponse({ status: response.status, body });
  if (probe.stage === 'rate-limited') {
    // Only the live response still has the limiter headers.
    return { ...probe, retryAfterSeconds: parseLoginRateFields(response.headers).retryAfterSeconds };
  }
  return probe;
}

/**
 * §6.6 step 1: bounded auto-retries, because the very first `/auth/session`
 * over a relay can race the tunnel's first WS attempt. Each retry is a fresh
 * probe; a 4xx answer stops immediately.
 */
export async function probeSessionGateWithRetries(
  runtime: SessionGateRuntime,
  probe: (runtime: SessionGateRuntime) => Promise<SessionProbe> = probeSessionGate,
): Promise<SessionProbe> {
  let attempt = 0;
  for (;;) {
    const outcome = await probe(runtime);
    if (!shouldAutoRetry(outcome.status, attempt)) return outcome;
    attempt += 1;
    await runtime.sleep(gateRetryDelayMs(attempt));
  }
}

// ---------------------------------------------------------------------------
// Password login
// ---------------------------------------------------------------------------

/**
 * `POST /auth/session` (§6.6 step 2). A minted `clientToken` (when the caller
 * asked for one) becomes the runtime bearer; the session cookie is set by the
 * server and rides `credentials:'include'`. Success marks the shared store
 * `ok` so the gate and the §6.7 banner can never disagree.
 */
export async function loginWithPassword(
  runtime: SessionGateRuntime,
  body: LoginRequestBody,
): Promise<PasswordLoginResult> {
  rememberTrustDevice(runtime, body.trustDevice === true);
  let response: Response;
  try {
    response = await runtime.fetch(SESSION_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return {
      ok: false,
      status: TRANSPORT_FAILURE_STATUS,
      error: error instanceof Error ? error.message : String(error),
      locked: false,
      tunnelLocked: false,
      retryAfterSeconds: null,
      clientToken: null,
    };
  }
  const payload = await readJsonRecord(response);
  if (response.ok) {
    const token = typeof payload?.clientToken === 'string' ? payload.clientToken : null;
    if (token !== null) setRuntimeBearerToken(token);
    markGateAuthenticated();
    return {
      ok: true,
      status: response.status,
      locked: false,
      tunnelLocked: false,
      retryAfterSeconds: null,
      clientToken: token,
    };
  }
  const rate = response.status === 429
    ? parseLoginRateFields(response.headers).retryAfterSeconds
    : null;
  return {
    ok: false,
    status: response.status,
    error: readError(payload),
    locked: payload?.locked === true || response.status === 429,
    tunnelLocked: payload?.tunnelLocked === true,
    retryAfterSeconds: rate,
    clientToken: null,
  };
}

/** §6.6 step 5: the shared store goes back to `ok` (banner disappears). */
export function markGateAuthenticated(): void {
  useAuthSessionStore.getState().markOk();
}

/** §6.7 step 4: the banner's "Log in" re-enters the gate through this state. */
export function beginGateReauthentication(): void {
  useAuthSessionStore.getState().beginReauthentication();
}

/** Presence known only by asking a live session; unknown is the honest default. */
export const UNKNOWN_PRESENCE: PasskeyPresence = { known: false, hasPasskeys: false, passkeysDisabled: false };

// Trust-device storage, passkey presence, and the (probe, support, presence)
// -> affordances mapping live in `sessionAuthGateView.ts`; this file stays the
// probe / payload half of §6.6.
