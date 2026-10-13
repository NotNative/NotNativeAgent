// SPDX-License-Identifier: Apache-2.0
/**
 * Pairing v2 link parsers + encoder (doc 08 §5.1/§5.2/§5.3) — the browser
 * mirror of `packages/web/src/server/lib/auth/pairing-payload.ts`.
 *
 * The link is exactly `openchamber://connect?v=2&p=<base64url(UTF-8 JSON)>`.
 * Every client converges on these two parsers:
 *  - `parsePairingConnectionPayload` — `new URL()`-based (the standard path);
 *  - `parsePairingConnectionPayloadString` — regex fallback for old Android
 *    WebViews where `new URL('openchamber://…')` yields hostname `''` and
 *    pathname `//connect` for a perfectly valid link. It keeps every
 *    validation the standard path performs.
 *
 * Both share `normalizePairingConnectionPayload`, which invalidates the whole
 * payload on any unknown candidate shape (§5.3: a partially understood link is
 * worse than a rejected one, because the redeem would otherwise succeed over an
 * unintended transport). v1 links are rejected forever — that is the designed-
 * out sin (a long-lived token embedded in QR text and browser history).
 *
 * Browser-safe by construction: Uint8Array + the shared base64url helpers, no
 * node:buffer and no DOM types, so the web server tsconfig compiles this file
 * and the cross-parity tests run the *same* module on both sides.
 */
import { base64UrlToBytes, bytesToBase64Url, utf8Bytes, utf8Text } from './relay/bytes.ts';

export const MAX_PAIRING_PAYLOAD_LENGTH = 16_384;
export const PAIRING_PROTOCOL = 'openchamber:';
export const PAIRING_HOSTNAME = 'connect';
/** Exact v2 link head (§5.1): new URL() must yield hostname 'connect'. */
export const PAIRING_LINK_PREFIX = 'openchamber://connect?v=2&p=';
export const PAIRING_VERSION = 2;
export const PRIORITY_DIRECT_PRIMARY = 10;
export const PRIORITY_DIRECT_ORIGIN = 20;
export const PRIORITY_RELAY = 30;

/** Old-WebView fallback head (§5.1): trailing slash tolerated, case-insensitive. */
const LEGACY_LINK_HEAD = /^openchamber:\/\/connect\/?$/iu;

export type PairingCandidate =
  | { type: 'lan'; url: string; priority?: number }
  | { type: 'tunnel'; url: string; priority?: number }
  | { type: 'relay'; relayUrl: string; serverId: string; hostEncPubJwk: RelayJwk; grant?: string; priority?: number };

export interface RelayJwk { kty: 'EC'; crv: 'P-256'; x: string; y: string }

export interface PairingConnectionPayload {
  v: 2;
  pairingId: string;
  secret: string;
  label?: string;
  fingerprint?: string;
  expiresAt: string;
  candidates: PairingCandidate[];
}

/** §6.1 step 6: the scanner hands the raw string to the parsers; camera
 * permission/cancel/unsupported are the caller's (doc 11) concern. */
export type ConnectionPayloadResult
  = { status: 'pairing'; payload: PairingConnectionPayload }
  | { status: 'invalid' }
  | { status: 'direct'; url: string };

/** Strict host-encryption JWK: {kty:'EC',crv:'P-256',x,y} only; any private
 * member (`d`), other curves, or missing members are rejected (§5.2). */
export function normalizeRelayJwk(value: unknown): RelayJwk | null {
  if (typeof value !== 'object' || value === null) return null;
  const jwk = value as Record<string, unknown>;
  if (jwk['d'] !== undefined) return null;
  if (jwk['kty'] !== 'EC' || jwk['crv'] !== 'P-256') return null;
  const x = jwk['x'];
  const y = jwk['y'];
  if (typeof x !== 'string' || x.length === 0 || typeof y !== 'string' || y.length === 0) return null;
  return { kty: 'EC', crv: 'P-256', x, y };
}

function finitePriority(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** URL candidates reject non-http(s); hash stripped; trailing slash RUNS stripped. */
function normalizeUrlCandidate(type: 'lan' | 'tunnel', value: unknown): PairingCandidate | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as { url?: unknown; priority?: unknown };
  let url = typeof raw.url === 'string' ? (raw.url.split('#')[0] ?? '').trim() : '';
  if (!/^https?:\/\//iu.test(url)) return null;
  url = url.replace(/\/+$/u, '');
  const priority = finitePriority(raw.priority);
  return { type, url, ...(priority !== null ? { priority } : {}) };
}

/** Relay candidates keep the relay path (e.g. /ws); ws/wss only. */
function normalizeRelayCandidate(value: unknown): PairingCandidate | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as { relayUrl?: unknown; serverId?: unknown; hostEncPubJwk?: unknown; grant?: unknown; priority?: unknown };
  const relayUrl = typeof raw.relayUrl === 'string' ? (raw.relayUrl.split('#')[0] ?? '').trim() : '';
  if (!/^wss?:\/\//iu.test(relayUrl)) return null;
  const serverId = typeof raw.serverId === 'string' ? raw.serverId.trim() : '';
  const jwk = normalizeRelayJwk(raw.hostEncPubJwk);
  if (serverId.length === 0 || jwk === null) return null;
  const grant = typeof raw.grant === 'string' && raw.grant.length > 0 ? raw.grant : undefined;
  const priority = finitePriority(raw.priority);
  return {
    type: 'relay',
    relayUrl,
    serverId,
    hostEncPubJwk: jwk,
    ...(grant !== undefined ? { grant } : {}),
    ...(priority !== null ? { priority } : {}),
  };
}

/** The shared normalizer: integer v===2, non-empty pairingId/secret, at least
 * one candidate, expiresAt parses AND is future. Unknown candidate shapes
 * invalidate the whole payload (§5.3). Byte-parity with the server mirror. */
export function normalizePairingConnectionPayload(value: unknown): PairingConnectionPayload | null {
  if (typeof value !== 'object' || value === null) return null;
  const payload = value as Record<string, unknown>;
  if (payload['v'] !== PAIRING_VERSION) return null;
  const pairingId = typeof payload['pairingId'] === 'string' ? payload['pairingId'].trim() : '';
  const secret = typeof payload['secret'] === 'string' ? payload['secret'].trim() : '';
  if (pairingId.length === 0 || secret.length === 0) return null;
  const candidatesRaw = Array.isArray(payload['candidates']) ? payload['candidates'] : [];
  const normalized: PairingCandidate[] = [];
  for (const candidate of candidatesRaw) {
    if (typeof candidate !== 'object' || candidate === null) return null; // a hole is not a best-effort skip
    const type = (candidate as { type?: unknown }).type;
    if (type === 'lan' || type === 'tunnel') {
      const entry = normalizeUrlCandidate(type, candidate);
      if (entry === null) return null;
      normalized.push(entry);
    } else if (type === 'relay') {
      const entry = normalizeRelayCandidate(candidate);
      if (entry === null) return null;
      normalized.push(entry);
    } else return null;
  }
  if (normalized.length < 1) return null;
  const expires = typeof payload['expiresAt'] === 'string' ? Date.parse(payload['expiresAt']) : Number.NaN;
  if (!Number.isFinite(expires) || expires <= Date.now()) return null;
  const label = typeof payload['label'] === 'string' && payload['label'].trim().length > 0 ? payload['label'].trim() : undefined;
  const fingerprint = typeof payload['fingerprint'] === 'string' && payload['fingerprint'].trim().length > 0 ? payload['fingerprint'].trim() : undefined;
  return {
    v: 2,
    pairingId,
    secret,
    ...(label !== undefined ? { label } : {}),
    ...(fingerprint !== undefined ? { fingerprint } : {}),
    expiresAt: payload['expiresAt'] as string,
    candidates: normalized,
  };
}

/** base64url(UTF-8 JSON) → parsed object; oversized or undecodable ⇒ null.
 * The decoded JSON length is bounded in characters, exactly like the server. */
export function decodePairingPayloadParameter(value: string): unknown {
  if (value.length === 0 || value.length > MAX_PAIRING_PAYLOAD_LENGTH) return null;
  let json: string;
  try {
    json = utf8Text(base64UrlToBytes(value));
  } catch {
    return null;
  }
  if (json.length > MAX_PAIRING_PAYLOAD_LENGTH) return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

function payloadFromParameter(raw: string | null): PairingConnectionPayload | null {
  if (raw === null) return null;
  const p = raw.trim();
  if (p.length === 0 || p.length > MAX_PAIRING_PAYLOAD_LENGTH) return null;
  return normalizePairingConnectionPayload(decodePairingPayloadParameter(p));
}

/** Standard parser (§5.1): protocol `openchamber:`, hostname `connect`,
 * `v === '2'`, non-empty `p`; unknown query keys ignored. */
export function parsePairingConnectionPayload(value: string): PairingConnectionPayload | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length === 0 || trimmed.length > MAX_PAIRING_PAYLOAD_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== PAIRING_PROTOCOL) return null;
  if (url.hostname !== PAIRING_HOSTNAME) return null;
  const params = new URLSearchParams(url.search);
  if (params.get('v') !== String(PAIRING_VERSION)) return null;
  return payloadFromParameter(params.get('p'));
}

/** Regex fallback for old Android WebViews (§5.1): the head is matched
 * literally, then v/p are read straight off the query string — order
 * independent, trailing slash tolerated, case-insensitive head. Every
 * validation still runs (version, length, base64url, candidate shapes). */
export function parsePairingConnectionPayloadString(value: string): PairingConnectionPayload | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length === 0 || trimmed.length > MAX_PAIRING_PAYLOAD_LENGTH) return null;
  const hashless = trimmed.split('#')[0] ?? '';
  const queryStart = hashless.indexOf('?');
  const head = queryStart < 0 ? hashless : hashless.slice(0, queryStart);
  if (!LEGACY_LINK_HEAD.test(head)) return null;
  const query = queryStart < 0 ? '' : hashless.slice(queryStart + 1);
  let version: string | null = null;
  let parameter: string | null = null;
  for (const pair of query.split('&')) {
    if (pair.length === 0) continue;
    const separator = pair.indexOf('=');
    const key = separator < 0 ? pair : pair.slice(0, separator);
    if (key === 'v') version = separator < 0 ? '' : pair.slice(separator + 1);
    else if (key === 'p') parameter = separator < 0 ? '' : pair.slice(separator + 1);
  }
  if (version !== String(PAIRING_VERSION)) return null;
  return payloadFromParameter(parameter);
}

/** §6.1 step 6: the scan-result entry point. URL parser first, string
 * fallback second (Android), then the legacy https raw-URL direct connect —
 * still accepted, but it is not a pairing. */
export function parseConnectionPayload(value: string): ConnectionPayloadResult {
  const pairing = parsePairingConnectionPayload(value) ?? parsePairingConnectionPayloadString(value);
  if (pairing !== null) return { status: 'pairing', payload: pairing };
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (/^https?:\/\//iu.test(trimmed)) return { status: 'direct', url: trimmed };
  return { status: 'invalid' };
}

/** Assembles the payload from structured input and emits the v2 link. The cap
 * applies to the JSON, to `p`, and to the whole link; invalid input throws
 * exactly like the server mirror. */
export function encodePairingConnectionPayload(input: {
  pairingId: string;
  secret: string;
  label?: string;
  fingerprint?: string;
  expiresAt: string;
  candidates: PairingCandidate[];
}): string {
  const payload = normalizePairingConnectionPayload({
    v: 2,
    pairingId: input.pairingId,
    secret: input.secret,
    expiresAt: input.expiresAt,
    candidates: input.candidates,
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.fingerprint !== undefined ? { fingerprint: input.fingerprint } : {}),
  });
  if (payload === null) throw new Error('Invalid pairing connection payload');
  const json = JSON.stringify(payload);
  if (json.length > MAX_PAIRING_PAYLOAD_LENGTH) throw new Error('Invalid pairing connection payload');
  const encoded = bytesToBase64Url(utf8Bytes(json));
  if (encoded.length > MAX_PAIRING_PAYLOAD_LENGTH) throw new Error('Invalid pairing connection payload');
  const link = PAIRING_LINK_PREFIX + encoded;
  if (link.length > MAX_PAIRING_PAYLOAD_LENGTH) throw new Error('Invalid pairing connection payload');
  return link;
}
