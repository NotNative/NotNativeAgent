// SPDX-License-Identifier: Apache-2.0
/**
 * Pairing v2 payload contract (doc 08 section 5.1-5.3): the link is
 * openchamber://connect?v=2&p=<base64url(UTF-8 JSON)>. The payload carries
 * the SERVER's name (label), the visual fingerprint, a guaranteed-future
 * expiresAt, and an ordered candidate list (lan | tunnel | relay) with the
 * canonical server priorities direct 10 / creator-origin direct 20 /
 * relay 30. The 16 384-char cap applies to the whole link, p, and the
 * decoded JSON. v1 links are rejected forever (the designed-out sin).
 */
import { Buffer } from 'node:buffer';

export const MAX_PAIRING_PAYLOAD_LENGTH = 16_384;
export const PAIRING_PROTOCOL = 'openchamber:';
export const PAIRING_HOSTNAME = 'connect';
/** Exact v2 link head (section 5.1): new URL() must yield hostname 'connect'. */
export const PAIRING_LINK_PREFIX = 'openchamber://connect?v=2&p=';
export const PAIRING_VERSION = 2;
export const PRIORITY_DIRECT_PRIMARY = 10;
export const PRIORITY_DIRECT_ORIGIN = 20;
export const PRIORITY_RELAY = 30;

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

/** Strict host-encryption JWK: {kty:'EC',crv:'P-256',x,y} only; any private
 * member (`d`), other curves, or missing members are rejected (section 5.2). */
export function normalizeRelayJwk(value: unknown): RelayJwk | null {
  if (typeof value !== 'object' || value === null) return null;
  const jwk = value as Record<string, unknown>;
  if (jwk['d'] !== undefined) return null;
  if (jwk['kty'] !== 'EC' || jwk['crv'] !== 'P-256') return null;
  if (typeof jwk['x'] !== 'string' || jwk['x'].length === 0 || typeof jwk['y'] !== 'string' || jwk['y'].length === 0) return null;
  return { kty: 'EC', crv: 'P-256', x: jwk['x'], y: jwk['y'] };
}

/** URL candidates reject non-http(s); hash stripped; trailing slash RUNS stripped. */
function normalizeUrlCandidate(type: 'lan' | 'tunnel', value: unknown): PairingCandidate | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as { url?: unknown; priority?: unknown };
  let url = typeof raw.url === 'string' ? raw.url.split('#')[0]!.trim() : '';
  if (!/^https?:\/\//iu.test(url)) return null;
  url = url.replace(/\/+$/u, '');
  const priority = finitePriority(raw.priority);
  return { type, url, ...(priority !== null ? { priority } : {}) };
}

/** Relay candidates keep the relay path (e.g. /ws); ws/wss only. */
function normalizeRelayCandidate(value: unknown): PairingCandidate | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as { relayUrl?: unknown; serverId?: unknown; hostEncPubJwk?: unknown; grant?: unknown; priority?: unknown };
  let relayUrl = typeof raw.relayUrl === 'string' ? raw.relayUrl.split('#')[0]!.trim() : '';
  if (!/^wss?:\/\//iu.test(relayUrl)) return null;
  const serverId = typeof raw.serverId === 'string' ? raw.serverId.trim() : '';
  const jwk = normalizeRelayJwk(raw.hostEncPubJwk);
  if (serverId.length === 0 || jwk === null) return null;
  const grant = typeof raw.grant === 'string' && raw.grant.length > 0 ? raw.grant : undefined;
  const priority = finitePriority(raw.priority);
  return { type: 'relay', relayUrl, serverId, hostEncPubJwk: jwk, ...(grant !== undefined ? { grant } : {}), ...(priority !== null ? { priority } : {}) };
}

function finitePriority(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The shared normalizer: integer v===2, non-empty pairingId/secret, at
 * least one candidate, expiresAt parses AND is future. Unknown candidate
 * shapes invalidate the whole payload (section 5.3). */
export function normalizePairingPayload(value: unknown): PairingConnectionPayload | null {
  if (typeof value !== 'object' || value === null) return null;
  const payload = value as Record<string, unknown>;
  if (payload['v'] !== PAIRING_VERSION) return null;
  const pairingId = typeof payload['pairingId'] === 'string' ? payload['pairingId'].trim() : '';
  const secret = typeof payload['secret'] === 'string' ? payload['secret'].trim() : '';
  if (pairingId.length === 0 || secret.length === 0) return null;
  const candidatesRaw = Array.isArray(payload['candidates']) ? payload['candidates'] : [];
  const normalized: PairingCandidate[] = [];
  for (const candidate of candidatesRaw) {
    if (typeof candidate !== 'object' || candidate === null) return null; // a hole is not a best-effort skip (section 5.3)
    const type = (candidate as { type?: unknown }).type;
    if (type === 'lan') { const entry = normalizeUrlCandidate('lan', candidate); if (entry === null) return null; normalized.push(entry); }
    else if (type === 'tunnel') { const entry = normalizeUrlCandidate('tunnel', candidate); if (entry === null) return null; normalized.push(entry); }
    else if (type === 'relay') { const entry = normalizeRelayCandidate(candidate); if (entry === null) return null; normalized.push(entry); }
    else return null;
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

/** Assembles the payload from structured input and emits the v2 link. The
 * 16 384-character cap applies to the decoded JSON, to `p`, and to the whole
 * link (section 5.1) - a JSON under the cap whose base64url form or link
 * exceeds it is still invalid. */
export function encodePairingConnectionPayload(input: {
  pairingId: string;
  secret: string;
  label?: string;
  fingerprint?: string;
  expiresAt: string;
  candidates: PairingCandidate[];
}): string {
  const payload = normalizePairingPayload({
    v: 2, pairingId: input.pairingId, secret: input.secret, expiresAt: input.expiresAt, candidates: input.candidates,
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.fingerprint !== undefined ? { fingerprint: input.fingerprint } : {}),
  });
  if (payload === null) throw new Error('Invalid pairing connection payload');
  const json = JSON.stringify(payload);
  if (json.length > MAX_PAIRING_PAYLOAD_LENGTH) throw new Error('Invalid pairing connection payload');
  const b64 = Buffer.from(json, 'utf8').toString('base64url');
  if (b64.length > MAX_PAIRING_PAYLOAD_LENGTH) throw new Error('Invalid pairing connection payload');
  const link = PAIRING_LINK_PREFIX + b64;
  if (link.length > MAX_PAIRING_PAYLOAD_LENGTH) throw new Error('Invalid pairing connection payload');
  return link;
}

export function b64urlDecodePayload(value: string): unknown {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}
