// SPDX-License-Identifier: Apache-2.0
import { runtimeFetch } from './runtime-fetch.ts';
import type { PushApi } from './api/push-types.ts';
import { pushBadge } from './browser-badge.ts';
import { sessionNotificationReceipt } from './session-notification-api.ts';

async function pushRequest(path: string, method = 'GET', body?: unknown): Promise<Record<string, unknown>> {
  const response = await runtimeFetch(`/api/push/${path}`, {
    method, credentials: 'include',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...(['visibility', 'badge', 'badge/reset'].includes(path) ? { signal: AbortSignal.timeout(5_000), keepalive: method === 'POST' } : {}),
  });
  if (!response.ok) throw new Error(`Push request failed (${response.status})`);
  const data: unknown = await response.json().catch(() => null);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`Push response is invalid (${response.status})`);
  return data as Record<string, unknown>;
}

async function acknowledged(path: string, method: string, body: unknown): Promise<{ ok: true }> {
  const data = await pushRequest(path, method, body);
  if (data.ok !== true) throw new Error('Push registration was not confirmed');
  return { ok: true };
}

export const browserPushApi: PushApi = {
  async getVapidPublicKey() {
    const data = await pushRequest('vapid-public-key');
    // VAPID uses a canonical base64url encoding of a 65-byte uncompressed P-256 key (0x04 prefix).
    if (typeof data.publicKey !== 'string' || !/^B[A-P][A-Za-z0-9_-]{84}[AEIMQUYcgkosw048]$/u.test(data.publicKey)) throw new Error('Push public key is invalid');
    return { publicKey: data.publicKey };
  },
  subscribe: (subscription) => acknowledged('subscribe', 'POST', subscription),
  unsubscribe: (subscription) => acknowledged('subscribe', 'DELETE', subscription),
  async setVisibility(presence) {
    const data = await pushRequest('visibility', 'POST', presence);
    if (data.ok !== true) throw new Error('Push visibility was not confirmed');
    const badge = data.badge === undefined ? undefined : pushBadge(data.badge);
    if (badge === null) throw new Error('Push badge is invalid');
    return { ok: true, ...(badge ? { badge } : {}) };
  },
  async getBadge() {
    const data = await pushRequest('badge'); const badge = pushBadge(data.badge);
    if (data.ok !== true || !badge) throw new Error('Push badge is invalid');
    return badge;
  },
  async resetBadge(sessionId, reason) {
    return (await sessionNotificationReceipt(sessionId, reason === 'view' ? 'view' : 'message-sent')).badge!;
  },
  setSessionViewed: (sessionId, viewed, clientId, sequence) => sessionNotificationReceipt(sessionId, viewed ? 'view' : 'unview', { clientId, sequence }),
  async getVisibility() {
    const data = await pushRequest('visibility');
    if (data.ok !== true || typeof data.visible !== 'boolean') throw new Error('Push visibility is invalid');
    return { ok: true, visible: data.visible };
  },
};
