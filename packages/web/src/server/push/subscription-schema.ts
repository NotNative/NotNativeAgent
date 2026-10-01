// SPDX-License-Identifier: Apache-2.0
import { createECDH, ECDH } from 'node:crypto';

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  owner: string;
  updatedAt: number;
}
export interface PushDocument {
  version: 1;
  vapid: { publicKey: string; privateKey: string };
  subscriptions: PushSubscriptionRecord[];
}
export const SUBSCRIPTION_LIMIT = 1_000;
export const OWNER_LIMIT = 8;

function keyBytes(value: unknown, size: number): Buffer | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/u.test(value) || value.length > 90) return null;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === size && bytes.toString('base64url') === value.replace(/=+$/u, '') ? bytes : null;
}

export function pushEndpoint(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash ? url.href : null;
  } catch { return null; }
}

export function pushSubscription(value: unknown, owner: string, now: number): PushSubscriptionRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = pushEndpoint(input.endpoint);
  const publicKey = keyBytes(input.keys?.p256dh, 65);
  const auth = keyBytes(input.keys?.auth, 16);
  if (!endpoint || !publicKey || !auth || publicKey[0] !== 4) return null;
  try { ECDH.convertKey(publicKey, 'prime256v1', undefined, undefined, 'uncompressed'); }
  catch { return null; }
  return { endpoint, keys: { p256dh: publicKey.toString('base64url'), auth: auth.toString('base64url') }, owner, updatedAt: now };
}

export function validPushDocument(value: unknown): value is PushDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const doc = value as PushDocument;
  if (doc.version !== 1 || !keyBytes(doc.vapid?.privateKey, 32) || !keyBytes(doc.vapid?.publicKey, 65)
    || !Array.isArray(doc.subscriptions) || doc.subscriptions.length > SUBSCRIPTION_LIMIT) return false;
  try {
    const pair = createECDH('prime256v1');
    pair.setPrivateKey(Buffer.from(doc.vapid.privateKey, 'base64url'));
    if (pair.getPublicKey().toString('base64url') !== doc.vapid.publicKey) return false;
  } catch { return false; }
  const endpoints = new Set<string>();
  const owners = new Map<string, number>();
  for (const entry of doc.subscriptions) {
    if (!entry || !/^[a-f0-9]{64}$/u.test(entry.owner) || !Number.isSafeInteger(entry.updatedAt) || entry.updatedAt < 0
      || !pushSubscription(entry, entry.owner, entry.updatedAt) || endpoints.has(entry.endpoint)) return false;
    endpoints.add(entry.endpoint);
    owners.set(entry.owner, (owners.get(entry.owner) ?? 0) + 1);
    if (owners.get(entry.owner)! > OWNER_LIMIT) return false;
  }
  return true;
}
