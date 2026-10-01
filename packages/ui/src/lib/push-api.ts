// SPDX-License-Identifier: Apache-2.0
import { runtimeFetch } from './runtime-fetch.ts';
import type { PushApi } from './api/push-types.ts';

async function pushRequest(path: string, method = 'GET', body?: unknown): Promise<Record<string, unknown>> {
  const response = await runtimeFetch(`/api/push/${path}`, {
    method, credentials: 'include',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
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
  setVisibility: (presence) => acknowledged('visibility', 'POST', presence),
  async getVisibility() {
    const data = await pushRequest('visibility');
    if (data.ok !== true || typeof data.visible !== 'boolean') throw new Error('Push visibility is invalid');
    return { ok: true, visible: data.visible };
  },
};
