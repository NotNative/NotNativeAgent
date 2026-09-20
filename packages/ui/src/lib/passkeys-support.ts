// SPDX-License-Identifier: Apache-2.0
/**
 * Passkey support detection and shared plumbing for the client passkey
 * library (doc 08 §2.5). Split out of `passkeys.ts` so neither file drifts
 * past the size gate; callers import the public face from `passkeys.ts`.
 *
 * Local support and host support are different questions. This module can
 * only answer the local one (`window.isSecureContext` + browser capability,
 * §2.5). The host additionally refuses passkeys until a UI password is
 * configured (§2.4), which surfaces as a 400 on any ceremony and is
 * reported as `passkeysDisabled`.
 */
import {
  browserSupportsPasskeys,
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
} from '@simplewebauthn/browser';
import { runtimeFetch } from './runtime-fetch.ts';

/** §2.5 endpoint constants — the exact server routes (§2.4). */
export const PASSKEY_ENDPOINTS = {
  registerOptions: '/auth/passkey/register/options',
  registerVerify: '/auth/passkey/register/verify',
  authenticateOptions: '/auth/passkey/authenticate/options',
  authenticateVerify: '/auth/passkey/authenticate/verify',
  list: '/api/passkeys',
  reset: '/api/auth/reset',
} as const;

/**
 * The synthetic status every HTTP hop degrades to when the transport itself
 * fails (sessionAuthGateState.ts defines the gate-side twin). A throwing
 * `fetch` must classify as a *shaped* failure — status 0 with the transport
 * message as the error text — so a relay outage can never wed a busy flag or
 * escape a ceremony as an unhandled rejection (§6.6.4 posture).
 */
export const CEREMONY_TRANSPORT_FAILURE_STATUS = 0;

/**
 * Server text when no UI password is configured (§2.4). Matched
 * case-insensitively against the response `error`.
 */
export const PASSKEYS_DISABLED_HINT = 'require ui password';
export const FALLBACK_DEVICE_LABEL = 'This device';
export const LABEL_MAX = 120;

export type PasskeySupportLevel = 'available' | 'unsupported';

export interface PasskeySupportState {
  level: PasskeySupportLevel;
  /** `window.isSecureContext` — passkeys need HTTPS or localhost (§2.5). */
  secureContext: boolean;
  /** Browser is capable of WebAuthn at all. */
  webauthn: boolean;
  /** Browser can do a passkey (platform authenticator or hybrid). */
  passkeys: boolean;
  /** Present unless level === 'available'. */
  reason?: string;
}

export interface PasskeyActionResult {
  ok: boolean;
  status: number;
  error?: string;
  passkeysDisabled?: boolean;
}

/** Mirrors the server's `StoredPasskeyRecord` minus the public key (§2.4). */
export interface StoredPasskey {
  id: string;
  counter: number;
  transports?: string[];
  deviceType: string;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string;
  label: string;
  rpID: string;
}

export interface PasskeyLoginResult {
  ok: boolean;
  /** Server echoed `authenticated: true` and set the session cookie. */
  authenticated: boolean;
  /** Minted device token, when `issueClientToken` was requested. */
  clientToken: string | null;
  status: number;
  error?: string;
  tunnelLocked?: boolean;
  locked?: boolean;
  /** Host refused because no UI password is configured (§2.4). */
  passkeysDisabled?: boolean;
}

export interface PasskeyRegisterResult {
  ok: boolean;
  status: number;
  error?: string;
  passkeysDisabled?: boolean;
}

export interface PasskeyListResult {
  ok: boolean;
  passkeys: StoredPasskey[];
  rpID?: string;
  status: number;
  error?: string;
  passkeysDisabled?: boolean;
}

export interface PasskeyRuntime {
  fetch: typeof runtimeFetch;
  startRegistration: typeof startRegistration;
  startAuthentication: typeof startAuthentication;
  supportsPasskeys: typeof browserSupportsPasskeys;
  supportsWebAuthn: typeof browserSupportsWebAuthn;
  abortService: typeof WebAuthnAbortService;
  /** `window.isSecureContext` (§2.5). Read per call, never cached. */
  secureContext(): boolean;
  userAgent(): string;
}

/**
 * Everything environmental sits behind this seam, so the ceremony state
 * machine can be driven from the node test environment (no DOM, no
 * authenticator).
 */
export function createPasskeyRuntime(overrides: Partial<PasskeyRuntime> = {}): PasskeyRuntime {
  const base: PasskeyRuntime = {
    fetch: runtimeFetch,
    startRegistration: startRegistration,
    startAuthentication: startAuthentication,
    supportsPasskeys: browserSupportsPasskeys,
    supportsWebAuthn: browserSupportsWebAuthn,
    abortService: WebAuthnAbortService,
    secureContext: readSecureContext,
    userAgent: readUserAgent,
  };
  return { ...base, ...overrides };
}

function readSecureContext(): boolean {
  const scope = globalThis as { window?: { isSecureContext?: unknown } };
  return scope.window?.isSecureContext === true;
}

function readUserAgent(): string {
  const scope = globalThis as { navigator?: { userAgent?: unknown } };
  const agent = scope.navigator?.userAgent;
  return typeof agent === 'string' ? agent : '';
}

/**
 * §2.5 `getPasskeySupportState()`. Secure context is the first gate: an
 * insecure origin cannot run WebAuthn no matter what the browser supports.
 */
export async function getPasskeySupportState(
  runtime: PasskeyRuntime = createPasskeyRuntime(),
): Promise<PasskeySupportState> {
  const secureContext = runtime.secureContext();
  const webauthn = guardedBoolean(runtime);
  if (!secureContext) return unsupported('Passkeys require HTTPS or localhost', secureContext, webauthn);
  if (!webauthn) return unsupported('This browser does not support WebAuthn', secureContext, webauthn);
  if ((await guardedPasskeySupport(runtime)) !== true) {
    return unsupported('No passkey authenticator is available', secureContext, webauthn);
  }
  return { level: 'available', secureContext, webauthn, passkeys: true };
}

function unsupported(
  reason: string,
  secureContext: boolean,
  webauthn: boolean,
): PasskeySupportState {
  return { level: 'unsupported', secureContext, webauthn, passkeys: false, reason };
}

function guardedBoolean(runtime: PasskeyRuntime): boolean {
  try {
    return runtime.supportsWebAuthn() === true;
  } catch {
    return false;
  }
}

async function guardedPasskeySupport(runtime: PasskeyRuntime): Promise<boolean> {
  try {
    return await runtime.supportsPasskeys();
  } catch {
    // Capability probing must never be the thing that breaks the login screen.
    return false;
  }
}

/**
 * §2.5 `isPasskeyCeremonyAbort(error)`. Covers both shapes the library can
 * raise: the `AbortError` name from a signal, and its
 * `ERROR_CEREMONY_ABORTED` code when the ceremony was replaced or cancelled.
 */
export function isPasskeyCeremonyAbort(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const failure = error as { name?: unknown; code?: unknown };
  if (failure.code === 'ERROR_CEREMONY_ABORTED') return true;
  return failure.name === 'AbortError';
}

/** §2.4 host refusal: no UI password configured. */
export function isPasskeysDisabledText(text: string | undefined): boolean {
  return typeof text === 'string' && text.toLowerCase().includes(PASSKEYS_DISABLED_HINT);
}

/** §2.5 `navigator.userAgent` or "This device", clamped to the server cap. */
export function passkeyLabel(runtime: PasskeyRuntime, preferred?: string): string {
  const wanted = typeof preferred === 'string' ? preferred.trim() : '';
  if (wanted !== '') return wanted.slice(0, LABEL_MAX);
  const agent = runtime.userAgent().trim();
  return agent === '' ? FALLBACK_DEVICE_LABEL : agent.slice(0, LABEL_MAX);
}

export interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

/** One JSON hop. Non-JSON bodies still classify by status. */
export async function requestJson(
  runtime: PasskeyRuntime,
  endpoint: string,
  body: unknown,
  method: 'POST' | 'GET' | 'DELETE' = 'POST',
): Promise<HttpResult> {
  const init: RequestInit = { method, credentials: 'include' };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  const response = await runtime.fetch(endpoint, init);
  return { status: response.status, body: await jsonRecord(response) };
}

/**
 * `requestJson` with the transport-failure floor: a rejected `fetch` degrades
 * to `status: 0` + the transport message instead of rejecting, so every HTTP
 * classifier above it (login, register, management) keeps its shape.
 */
export async function tolerantRequestJson(
  runtime: PasskeyRuntime,
  endpoint: string,
  body: unknown,
  method: 'POST' | 'GET' | 'DELETE' = 'POST',
): Promise<HttpResult> {
  try {
    return await requestJson(runtime, endpoint, body, method);
  } catch (error) {
    return { status: CEREMONY_TRANSPORT_FAILURE_STATUS, body: { error: describeError(error) } };
  }
}

async function jsonRecord(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await response.json();
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function actionFailure(
  status: number,
  error: string,
  body?: Record<string, unknown>,
): PasskeyActionResult {
  return {
    ok: false,
    status,
    error,
    // Either channel may carry the server's refusal; the body wins when present.
    passkeysDisabled: isPasskeysDisabledText(errorText(body) ?? error),
  };
}

export function errorText(body: Record<string, unknown> | undefined): string | undefined {
  const text = body?.error;
  return typeof text === 'string' && text !== '' ? text : undefined;
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

