// SPDX-License-Identifier: Apache-2.0
/** Renderer-side relay redemption for desktop pairing links. The admission
 * grant is supplied to exactly one tunnel connection and never returned. */
import { createRelayTunnelClient } from './relay/tunnel-client.ts';
import type { RelayTunnelClient } from './relay/tunnel-client-types.ts';
import type { PairingCandidate, PairingConnectionPayload } from './connection-payload.ts';

const MAX_REDEEM_BYTES = 64 * 1024;
const REDEEM_TIMEOUT_MS = 15_000;

export interface RelayPairingIdentity {
  installId: string;
  platform: string;
  appVersion: string;
}

export interface RelayPairingResult {
  clientToken: string;
  serverLabel: string | null;
  /** Public steady-state descriptor only; the one-time grant is excluded. */
  relay: { relayUrl: string; serverId: string; hostEncPubJwk: NonNullable<Extract<PairingCandidate, { type: 'relay' }>['hostEncPubJwk']> };
}

export type RelayPairingClientFactory = (candidate: Extract<PairingCandidate, { type: 'relay' }>) => RelayTunnelClient;

async function boundedJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_REDEEM_BYTES) throw new Error('response-too-large');
  if (!response.body) throw new Error('invalid-json-response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REDEEM_BYTES) {
        await reader.cancel();
        throw new Error('response-too-large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('invalid-json-response'); }
}

function safeString(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;
}

/** Redeem a v2 pairing record over its relay candidate. Call only after
 * native/user consent; the relay admission grant is a connection-only value. */
export async function redeemDesktopPairingOverRelay(
  payload: PairingConnectionPayload,
  candidate: Extract<PairingCandidate, { type: 'relay' }>,
  identity: RelayPairingIdentity,
  createClient: RelayPairingClientFactory = (descriptor) => createRelayTunnelClient({
    relayUrl: descriptor.relayUrl,
    serverId: descriptor.serverId,
    hostEncPubJwk: descriptor.hostEncPubJwk,
    grant: descriptor.grant,
    platform: identity.platform,
    appVersion: identity.appVersion,
  }),
): Promise<RelayPairingResult> {
  const expiresAt = Date.parse(payload.expiresAt);
  if (payload.v !== 2 || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('pairing-expired');
  // The one-time secret must only be sent to a relay identity advertised by
  // the consented link. Otherwise a caller bug could encrypt the redeem POST
  // to an unrelated host key and disclose the secret to that host.
  const authorizedCandidate = payload.candidates.some((entry) => entry.type === 'relay'
    && entry.relayUrl === candidate.relayUrl
    && entry.serverId === candidate.serverId
    && entry.hostEncPubJwk.kty === candidate.hostEncPubJwk.kty
    && entry.hostEncPubJwk.crv === candidate.hostEncPubJwk.crv
    && entry.hostEncPubJwk.x === candidate.hostEncPubJwk.x
    && entry.hostEncPubJwk.y === candidate.hostEncPubJwk.y
    && entry.grant === candidate.grant);
  if (!authorizedCandidate) throw new Error('pairing-candidate-mismatch');
  if (!safeString(identity.installId, 256) || !safeString(identity.platform, 64)
    || !safeString(identity.appVersion, 64)) throw new Error('invalid-desktop-identity');
  const client = createClient(candidate);
  try {
    const response = await client.fetch('/api/client-auth/pairing/redeem', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        pairingId: payload.pairingId,
        secret: payload.secret,
        clientLabel: 'NotNativeDesktop',
        clientKind: 'desktop',
        deviceName: 'NotNativeDesktop',
        devicePlatform: identity.platform,
        appVersion: identity.appVersion,
        dedupeKey: `desktop:${identity.installId}`,
      }),
      signal: AbortSignal.timeout(REDEEM_TIMEOUT_MS),
    });
    const body = await boundedJson(response) as { ok?: unknown; clientToken?: unknown; server?: { label?: unknown } };
    const clientToken = safeString(body?.clientToken, 8_192);
    if (!response.ok || body?.ok !== true || !clientToken) throw new Error('pairing-rejected');
    return {
      clientToken,
      serverLabel: safeString(body.server?.label, 256),
      relay: {
        relayUrl: candidate.relayUrl,
        serverId: candidate.serverId,
        hostEncPubJwk: candidate.hostEncPubJwk,
      },
    };
  } finally {
    client.close();
  }
}
