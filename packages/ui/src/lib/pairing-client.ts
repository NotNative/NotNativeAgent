// SPDX-License-Identifier: Apache-2.0
/**
 * Pairing client (doc 08 §6.1 steps 1-5): the UI asks the server for its
 * transport picture, plans the create body from the operator's scope choice,
 * creates the one-time pairing, and assembles the connection link locally —
 * §5.8 is explicit that the server never renders QRs and payload assembly is
 * a shared-UI concern.
 *
 * Every row type here mirrors the server's sanitized outbound shape
 * (routes/client-auth.ts + sanitizeOutboundClient): the client never receives
 * `secretHash` or `tokenHash`, and the one-time `secret` exists only in the
 * create response and the encoded link (§5.2, §12.3). All stamps are the
 * server's ISO-8601 strings; the UI never invents its own expiry format.
 */
import {
  encodePairingConnectionPayload,
  type PairingCandidate,
} from './connection-payload.ts';
import { runtimeFetch } from './runtime-fetch.ts';

/** The §6.1 scope radio: this computer / home network / anywhere. */
export type PairingScope = 'local' | 'lan' | 'anywhere';

/** GET /api/client-auth/pairing/transports — LAN reflects the server bind. */
export interface PairingTransports {
  local: string;
  lan: string | null;
  relayAvailable: boolean;
}

/** The one-time session row from the create reply (§5.3 minus secretHash). */
export interface CreatedPairing {
  id: string;
  /** One-time plaintext pairing secret; exists only here and in the link. */
  secret: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  cancelledAt: string | null;
  clientId: string | null;
  label: string | null;
  fingerprint: string;
  allowedClientKinds: string[];
  createdByClientId: string | null;
  usesRelay: boolean;
}

/** POST create response: the one-time session plus the server candidate set. */
export interface PairingCreateResponse {
  pairing: CreatedPairing;
  server: { label: string; candidates: PairingCandidate[] };
}

/** Pending pairing row (§6.1 step 9: label, expiry, via-relay chip). */
export interface PendingPairingRow {
  id: string;
  label: string | null;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  cancelledAt: string | null;
  clientId: string | null;
  fingerprint: string;
  allowedClientKinds: string[];
  createdByClientId: string | null;
  usesRelay: boolean;
}

/** Remote-client row (§2.7 list; `tokenHash` is stripped server-side). */
export interface RemoteClientRow {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string;
  revokedAt: string | null;
  expiresAt?: string;
  clientKind: string;
  usesRelay: boolean;
  lastTransport: 'relay' | 'direct';
  authMethod?: string;
  pairingId?: string;
  deviceName?: string;
  devicePlatform?: string;
  deviceModel?: string;
  appVersion?: string;
}

export interface PairingRuntime {
  fetch: typeof runtimeFetch;
  /** Clock seam: expiry comparisons in the watcher ride this. */
  now(): number;
}

export class PairingApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'PairingApiError';
    this.status = status;
  }
}

export function createPairingRuntime(
  overrides: Partial<PairingRuntime> = {},
): PairingRuntime {
  return {
    fetch: (input, init) => runtimeFetch(input, init),
    now: () => Date.now(),
    ...overrides,
  };
}

const CLIENT_KINDS = ['mobile', 'desktop'] as const;

/** §6.1 step 2: what each scope choice sends to the create route. */
export interface PairingRequestBody {
  label: string | null;
  allowedClientKinds: readonly string[];
  serverUrl?: string;
  includeRelay?: boolean;
  includeDirect?: boolean;
}

export type PairingPlan =
  | { ok: true; body: PairingRequestBody }
  | { ok: false; reason: 'no-loopback' | 'no-lan' | 'relay-unavailable' | 'empty-scope' };

/**
 * Maps the dialog state onto the create body (§6.1 step 2). The checkbox's
 * relay consent is operator intent, so it is sent as `includeRelay: true`
 * whenever it is on — the route force-starts the relay host for that flag
 * (§5.5/§6.1 step 3) — and `includeRelay: false` exactly when it is off.
 * Only the scopes that actually decide send the flag; falling back to the
 * route default would silently mean "relay if it happens to be enabled".
 */
export function planPairingRequest(
  scope: PairingScope,
  transports: PairingTransports,
  label: string,
  relayFallback: boolean,
): PairingPlan {
  const trimmed = label.trim() === '' ? null : label.trim();
  const base: PairingRequestBody = { label: trimmed, allowedClientKinds: CLIENT_KINDS };
  if (scope === 'local') {
    if (transports.local === '') return { ok: false, reason: 'no-loopback' };
    return { ok: true, body: { ...base, serverUrl: transports.local, includeRelay: false } };
  }
  if (scope === 'lan') {
    if (transports.lan === null) return { ok: false, reason: 'no-lan' };
    return { ok: true, body: { ...base, serverUrl: transports.lan, includeRelay: relayFallback } };
  }
  // 'anywhere': the relay is the scope. While the fallback checkbox is on the
  // consent is given, so the request carries the LAN candidate too and lets
  // the server force-start the relay (an unstartable relay answers 503 and is
  // shown as a create error, never silently dropped).
  if (relayFallback) {
    if (transports.lan !== null) {
      return { ok: true, body: { ...base, serverUrl: transports.lan, includeRelay: true } };
    }
    return { ok: true, body: { ...base, includeRelay: true, includeDirect: false } };
  }
  // Fallback off with the transports view unable to offer a relay: the dialog
  // refuses with guidance instead of force-starting a relay the operator may
  // have deliberately disabled (adaptation delta E-08-52). `empty-scope` is
  // kept in the plan vocabulary for completeness; 'anywhere' always has one.
  if (!transports.relayAvailable) return { ok: false, reason: 'relay-unavailable' };
  return { ok: true, body: { ...base, includeRelay: true, includeDirect: false } };
}

type FetchInit = Parameters<typeof runtimeFetch>[1];

async function callJson<T>(
  runtime: PairingRuntime,
  url: string,
  init?: FetchInit,
): Promise<T> {
  const response = await runtime.fetch(url, init);
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = (body as { error?: unknown } | null)?.error;
    throw new PairingApiError(
      response.status,
      typeof detail === 'string' && detail !== '' ? detail : `Request failed (${response.status})`,
    );
  }
  return body as T;
}

/** §6.1 step 1: the server's own transport picture. */
export async function fetchPairingTransports(
  runtime: PairingRuntime,
): Promise<PairingTransports> {
  const body = await callJson<Partial<PairingTransports>>(
    runtime,
    '/api/client-auth/pairing/transports',
  );
  return {
    local: typeof body.local === 'string' ? body.local : '',
    lan: typeof body.lan === 'string' && body.lan !== '' ? body.lan : null,
    relayAvailable: body.relayAvailable === true,
  };
}

/**
 * §6.1 steps 3-4: create the session, then build the link from the server's
 * own answer. The candidates pass through unchanged — the route already
 * answers in the §5.1 payload candidate shape, and re-ordering them here
 * would fight the server's priority assignment.
 */
export async function createPairingLink(
  input: {
    scope: PairingScope;
    transports: PairingTransports;
    label: string;
    relayFallback: boolean;
  },
  runtime: PairingRuntime,
): Promise<{ link: string; response: PairingCreateResponse; planned: PairingRequestBody }> {
  const plan = planPairingRequest(input.scope, input.transports, input.label, input.relayFallback);
  if (!plan.ok) {
    throw new PairingApiError(0, `Pairing scope cannot be honoured (${plan.reason})`);
  }
  const response = await callJson<PairingCreateResponse>(
    runtime,
    '/api/client-auth/pairing/sessions',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(plan.body),
    },
  );
  const link = encodePairingConnectionPayload({
    pairingId: response.pairing.id,
    secret: response.pairing.secret,
    expiresAt: response.pairing.expiresAt,
    // §6.1 step 4: the device names its connection by the issuing machine.
    label: response.server.label,
    fingerprint: response.pairing.fingerprint,
    candidates: response.server.candidates,
  });
  return { link, response, planned: plan.body };
}

/** §6.1 step 5: the pending list (silent-mode poll keeps the old rows). */
export async function listPendingPairings(
  runtime: PairingRuntime,
): Promise<PendingPairingRow[]> {
  const body = await callJson<{ pending?: unknown }>(runtime, '/api/client-auth/pairing/sessions');
  const rows = Array.isArray(body.pending) ? body.pending : [];
  return rows.filter((row): row is PendingPairingRow => isPendingRow(row));
}

function isPendingRow(row: unknown): row is PendingPairingRow {
  if (typeof row !== 'object' || row === null) return false;
  const record = row as Partial<PendingPairingRow>;
  return typeof record.id === 'string' && typeof record.expiresAt === 'string';
}

/** §6.1 step 8: the device list is the other half of the redemption signal. */
export async function listRemoteClients(
  runtime: PairingRuntime,
): Promise<RemoteClientRow[]> {
  const body = await callJson<{ clients?: unknown }>(runtime, '/api/client-auth/clients');
  const rows = Array.isArray(body.clients) ? body.clients : [];
  return rows.filter((row): row is RemoteClientRow => {
    if (typeof row !== 'object' || row === null) return false;
    return typeof (row as Partial<RemoteClientRow>).id === 'string';
  });
}

/** §6.1 step 9: cancel a pending row (the route reconciles the relay itself). */
export async function cancelPairingSession(
  id: string,
  runtime: PairingRuntime,
): Promise<boolean> {
  const body = await callJson<{ cancelled?: unknown }>(
    runtime,
    `/api/client-auth/pairing/sessions/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  );
  return body.cancelled === true;
}
