// SPDX-License-Identifier: Apache-2.0
import { useEffect } from 'react';
import { normalizePairingConnectionPayload } from '../../lib/connection-payload.ts';
import { redeemDesktopPairingOverRelay } from '../../lib/desktop-relay-pairing.ts';

interface RelayPairingRequest {
  requestId: string;
  payload: unknown;
  candidate: unknown;
  installId: string;
  platform: string;
  version: string;
}

function errorCode(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  return new Set([
    'pairing-expired', 'pairing-candidate-mismatch', 'pairing-rejected', 'pairing-rate-limited',
    'response-too-large', 'invalid-json-response', 'invalid-desktop-identity',
  ]).has(code) ? code : 'relay-failed';
}

async function redeem(request: RelayPairingRequest): Promise<{ ok: boolean; clientToken?: string; serverLabel?: string | null; error?: string }> {
  const invoke = window.__NOTNATIVE_DESKTOP_INVOKE__;
  if (!invoke) return { ok: false, error: 'desktop-pairing-unavailable' };
  // The native process checks expiry before it emits the request, but the
  // renderer may be starting or busy when that event arrives. Preserve the
  // expiry result instead of letting normalization collapse it into an
  // invalid-payload error (which the native UI reports as a network failure).
  const rawExpiresAt = typeof request.payload === 'object' && request.payload !== null
    ? (request.payload as { expiresAt?: unknown }).expiresAt : undefined;
  if (typeof rawExpiresAt === 'string') {
    const expiresAt = Date.parse(rawExpiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) return { ok: false, error: 'pairing-expired' };
  }
  const payload = normalizePairingConnectionPayload(request.payload);
  const candidatePayload = payload && normalizePairingConnectionPayload({
    ...payload, candidates: [request.candidate],
  });
  const candidate = candidatePayload?.candidates[0];
  if (!payload || candidate?.type !== 'relay'
    || typeof request.installId !== 'string' || typeof request.platform !== 'string'
    || typeof request.version !== 'string') return { ok: false, error: 'invalid-pairing-request' };
  try {
    const result = await redeemDesktopPairingOverRelay(payload, candidate, {
      installId: request.installId,
      platform: request.platform,
      appVersion: request.version,
    });
    return { ok: true, clientToken: result.clientToken, serverLabel: result.serverLabel };
  } catch (error) {
    return { ok: false, error: errorCode(error) };
  }
}

/** Services one-shot relay redemption requests from Electron main. */
export function DesktopRelayPairingBridge(): null {
  useEffect(() => {
    const events = window.__NOTNATIVE_DESKTOP_EVENTS__;
    const invoke = window.__NOTNATIVE_DESKTOP_INVOKE__;
    if (!events || !invoke) return undefined;
    return events.onRelayPairingRequest((request) => {
      void redeem(request).then((result) => invoke('desktop_pairing_redeem_relay_complete', {
        requestId: request.requestId,
        result,
      })).catch(() => undefined);
    });
  }, []);
  return null;
}
