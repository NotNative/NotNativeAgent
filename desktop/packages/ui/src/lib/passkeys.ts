// SPDX-License-Identifier: Apache-2.0
/**
 * Client passkey library (doc 08 §2.5). Thin, testable shell around
 * `@simplewebauthn/browser`: every ceremony is options → authenticator →
 * verify, and every HTTP hop rides `runtimeFetch` with
 * `credentials: 'include'` so the session cookie travels.
 *
 * Support detection, the environment seam, and the JSON plumbing live in
 * `passkeys-support.ts`. One rule worth repeating: a cancelled ceremony is
 * NOT a failure — `isPasskeyCeremonyAbort` splits user-cancel from real
 * breakage, and the gate (§6.6) treats the two completely differently.
 */
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';
import {
  actionFailure,
  asBoolean,
  createPasskeyRuntime,
  describeError,
  errorText,
  getPasskeySupportState,
  isPasskeyCeremonyAbort,
  isPasskeysDisabledText,
  passkeyLabel,
  tolerantRequestJson,
  PASSKEY_ENDPOINTS,
} from './passkeys-support.ts';
import type {
  PasskeyActionResult,
  PasskeyLoginResult,
  PasskeyRegisterResult,
  PasskeyListResult,
  PasskeyRuntime,
  PasskeySupportState,
  StoredPasskey,
} from './passkeys-support.ts';
import { setRuntimeBearerToken } from './runtime-auth.ts';

export * from './passkeys-support.ts';

export interface PasskeyClientOptions {
  /** Desktop-style login also mints a client token (§2.4). */
  issueClientToken?: boolean;
  clientKind?: string;
  clientLabel?: string;
  dedupeKey?: string;
  deviceName?: string;
  devicePlatform?: string;
  deviceModel?: string;
  appVersion?: string;
}

export interface PasskeyLibrary {
  supportState(): Promise<PasskeySupportState>;
  login(trustDevice: boolean, options?: PasskeyClientOptions): Promise<PasskeyLoginResult>;
  register(label?: string): Promise<PasskeyRegisterResult>;
  list(): Promise<PasskeyListResult>;
  revoke(id: string): Promise<PasskeyActionResult>;
  resetAll(): Promise<PasskeyActionResult>;
  cancel(): void;
}

export function createPasskeyLibrary(
  runtime: PasskeyRuntime = createPasskeyRuntime(),
): PasskeyLibrary {
  return {
    supportState: () => getPasskeySupportState(runtime),
    login: (trustDevice, options) => authenticateWithPasskey(runtime, trustDevice, options),
    register: (label) => registerCurrentDevicePasskey(runtime, label),
    list: () => listPasskeys(runtime),
    revoke: (id) => revokePasskey(runtime, id),
    resetAll: () => resetPasskeyAuth(runtime),
    cancel: () => cancelPasskeyCeremony(runtime),
  };
}

/** §2.5 `authenticateWithPasskey(trustDevice, options)`. */
export async function authenticateWithPasskey(
  runtime: PasskeyRuntime,
  trustDevice: boolean,
  options: PasskeyClientOptions = {},
): Promise<PasskeyLoginResult> {
  const challenge = await fetchCeremonyOptions(runtime, PASSKEY_ENDPOINTS.authenticateOptions);
  if (challenge.payload === null) return loginFailure(challenge);
  const started = await runCeremony(runtime, challenge, 'authenticate');
  if (started.response === null) {
    return loginRefused(challenge.status, started.error ?? 'ceremony failed');
  }
  const body = {
    ...started.response,
    requestId: challenge.requestId,
    trustDevice,
    issueClientToken: options.issueClientToken ?? false,
    ...mintFields(options),
  };
  return verifyLogin(await tolerantRequestJson(runtime, PASSKEY_ENDPOINTS.authenticateVerify, body));
}

type CeremonyKind = 'authenticate' | 'register';

interface CeremonyRun {
  response: AuthenticationResponseJSON | RegistrationResponseJSON | null;
  error?: string;
}

/** One authenticator round, with cancel/breakage classification. */
async function runCeremony(
  runtime: PasskeyRuntime,
  challenge: CeremonyChallenge,
  kind: CeremonyKind,
): Promise<CeremonyRun> {
  const payload = challenge.payload;
  if (payload === null) return { response: null, error: 'no ceremony options' };
  try {
    if (kind === 'register') {
      const created = await runtime.startRegistration({
        optionsJSON: payload as unknown as PublicKeyCredentialCreationOptionsJSON,
        useAutoRegister: false,
      });
      return { response: created };
    }
    const asserted = await runtime.startAuthentication({
      optionsJSON: payload as unknown as PublicKeyCredentialRequestOptionsJSON,
    });
    return { response: asserted };
  } catch (error) {
    return {
      response: null,
      error: isPasskeyCeremonyAbort(error) ? 'cancelled' : describeError(error),
    };
  }
}

function verifyLogin(got: { status: number; body: Record<string, unknown> }): PasskeyLoginResult {
  if (got.status !== 200 || asBoolean(got.body.authenticated) !== true) {
    return {
      ok: false,
      authenticated: false,
      clientToken: null,
      status: got.status,
      error: errorText(got.body) ?? `HTTP ${got.status}`,
      tunnelLocked: asBoolean(got.body.tunnelLocked),
      locked: asBoolean(got.body.locked),
      passkeysDisabled: isPasskeysDisabledText(errorText(got.body)),
    };
  }
  const token = got.body.clientToken;
  return {
    ok: true,
    authenticated: true,
    clientToken: typeof token === 'string' ? token : null,
    status: 200,
  };
}

/** §2.5 `registerCurrentDevicePasskey()`; label defaults to the UA (§2.4). */
export async function registerCurrentDevicePasskey(
  runtime: PasskeyRuntime,
  label?: string,
): Promise<PasskeyRegisterResult> {
  const challenge = await fetchCeremonyOptions(runtime, PASSKEY_ENDPOINTS.registerOptions);
  if (challenge.payload === null) {
    return actionFailure(challenge.status, challengeMessage(challenge), challenge.body);
  }
  const started = await runCeremony(runtime, challenge, 'register');
  if (started.response === null) {
    return actionFailure(challenge.status, started.error ?? 'ceremony failed', challenge.body);
  }
  const body = { ...started.response, requestId: challenge.requestId, label: passkeyLabel(runtime, label) };
  const verified = await tolerantRequestJson(runtime, PASSKEY_ENDPOINTS.registerVerify, body);
  if (verified.status !== 200 || asBoolean(verified.body.verified) !== true) {
    return actionFailure(verified.status, errorText(verified.body) ?? `HTTP ${verified.status}`, verified.body);
  }
  return { ok: true, status: 200 };
}

/** §2.4 management: `GET /api/passkeys`. */
export async function listPasskeys(runtime: PasskeyRuntime): Promise<PasskeyListResult> {
  const got = await tolerantRequestJson(runtime, PASSKEY_ENDPOINTS.list, undefined, 'GET');
  if (got.status !== 200) {
    const failed = actionFailure(got.status, errorText(got.body) ?? `HTTP ${got.status}`, got.body);
    return { ok: false, passkeys: [], status: failed.status, error: failed.error, passkeysDisabled: failed.passkeysDisabled };
  }
  return {
    ok: true,
    passkeys: parseStoredPasskeys(got.body.passkeys),
    rpID: typeof got.body.rpID === 'string' ? got.body.rpID : undefined,
    status: 200,
  };
}

/** §2.4 management: `DELETE /api/passkeys/:id`. */
export async function revokePasskey(
  runtime: PasskeyRuntime,
  id: string,
): Promise<PasskeyActionResult> {
  const trimmed = id.trim();
  if (trimmed === '') return { ok: false, status: 0, error: 'Passkey id is required' };
  const got = await tolerantRequestJson(
    runtime,
    `${PASSKEY_ENDPOINTS.list}/${encodeURIComponent(trimmed)}`,
    undefined,
    'DELETE',
  );
  if (got.status !== 200) {
    return actionFailure(got.status, errorText(got.body) ?? `HTTP ${got.status}`, got.body);
  }
  return { ok: true, status: 200 };
}

/** §2.2 global sign-out: rotate the JWT secret, killing every session. */
export async function resetPasskeyAuth(runtime: PasskeyRuntime): Promise<PasskeyActionResult> {
  const got = await tolerantRequestJson(runtime, PASSKEY_ENDPOINTS.reset, {});
  if (got.status !== 200) {
    return actionFailure(got.status, errorText(got.body) ?? `HTTP ${got.status}`, got.body);
  }
  // Every cookie session just died; a remembered bearer token is worthless.
  setRuntimeBearerToken(null);
  return { ok: true, status: 200 };
}

/** §2.5 `cancelPasskeyCeremony()` — aborts the in-flight ceremony, if any. */
export function cancelPasskeyCeremony(
  runtime: PasskeyRuntime = createPasskeyRuntime(),
): void {
  runtime.abortService.cancelCeremony();
}

interface CeremonyChallenge {
  status: number;
  body: Record<string, unknown>;
  payload: Record<string, unknown> | null;
  requestId: string | null;
  error?: string;
}

/**
 * Options hop. The server returns `{...options, requestId}`; the requestId
 * rides the verify body and is one-time-consumed server-side, so it never
 * goes to the authenticator.
 */
async function fetchCeremonyOptions(
  runtime: PasskeyRuntime,
  endpoint: string,
): Promise<CeremonyChallenge> {
  const got = await tolerantRequestJson(runtime, endpoint, {});
  const requestId = typeof got.body.requestId === 'string' ? got.body.requestId : null;
  const failure = errorText(got.body);
  if (got.status !== 200 || failure !== undefined || requestId === null) {
    return {
      status: got.status,
      body: got.body,
      payload: null,
      requestId,
      error: failure ?? `HTTP ${got.status}`,
    };
  }
  const { requestId: _used, error: _checked, ...payload } = got.body;
  return { status: got.status, body: got.body, payload, requestId, error: undefined };
}

function mintFields(options: PasskeyClientOptions): Record<string, string> {
  const fields: Record<string, string> = {};
  const keys: (keyof PasskeyClientOptions)[] = [
    'clientKind', 'clientLabel', 'dedupeKey', 'deviceName', 'devicePlatform', 'deviceModel', 'appVersion',
  ];
  for (const key of keys) {
    const value = options[key];
    if (typeof value === 'string' && value.trim() !== '') fields[key] = value;
  }
  return fields;
}

function loginFailure(challenge: CeremonyChallenge): PasskeyLoginResult {
  return {
    ok: false,
    authenticated: false,
    clientToken: null,
    status: challenge.status,
    error: challengeMessage(challenge),
    tunnelLocked: asBoolean(challenge.body.tunnelLocked),
    locked: asBoolean(challenge.body.locked),
    passkeysDisabled: isPasskeysDisabledText(challenge.error),
  };
}

/** A rejected options hop always has a cause; the status is the fallback. */
function challengeMessage(challenge: CeremonyChallenge): string {
  return challenge.error ?? `HTTP ${challenge.status}`;
}

function loginRefused(status: number, error: string): PasskeyLoginResult {
  return { ok: false, authenticated: false, clientToken: null, status, error };
}

function parseStoredPasskeys(value: unknown): StoredPasskey[] {
  if (!Array.isArray(value)) return [];
  const rows: StoredPasskey[] = [];
  for (const entry of value) {
    const row = storedPasskey(entry);
    if (row !== null) rows.push(row);
  }
  return rows;
}

function storedPasskey(value: unknown): StoredPasskey | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : '';
  const rpID = typeof record.rpID === 'string' ? record.rpID : '';
  if (id === '' || rpID === '') return null;
  return {
    id,
    label: typeof record.label === 'string' ? record.label : '',
    rpID,
    counter: typeof record.counter === 'number' ? record.counter : 0,
    deviceType: typeof record.deviceType === 'string' ? record.deviceType : '',
    backedUp: record.backedUp === true,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
    lastUsedAt: typeof record.lastUsedAt === 'string' ? record.lastUsedAt : '',
    transports: Array.isArray(record.transports)
      ? record.transports.filter((item): item is string => typeof item === 'string')
      : undefined,
  };
}

/** Singleton face used by the gate, banner, and settings screens. */
export const passkeys = createPasskeyLibrary();
