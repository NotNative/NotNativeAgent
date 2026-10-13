// SPDX-License-Identifier: Apache-2.0
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import webPush from 'web-push';
import { pushEndpoint, type PushSubscriptionRecord, type PushDocument } from './subscription-schema.ts';

type Address = { address: string; family: number };
export type PushResolver = (hostname: string) => Promise<Address[]>;
export type PushPost = (url: URL, address: Address, details: webPush.RequestDetails, signal?: AbortSignal) => Promise<number>;

export function publicPushAddress(address: string): boolean {
  try {
    const parsed = ipaddr.parse(address);
    if (parsed.kind() === 'ipv6') {
      const ipv6 = parsed as ipaddr.IPv6;
      return ipv6.range() === 'unicast' && ipv6.match(ipaddr.parse('2000::') as ipaddr.IPv6, 3);
    }
    return parsed.range() === 'unicast';
  } catch { return false; }
}

export function pushSubject(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4_096) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash || url.search) return null;
    if (url.protocol === 'https:' && url.hostname !== 'localhost') return url.href;
    if (url.protocol === 'mailto:' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(url.pathname)) return url.href;
  } catch { /* invalid configuration disables sending */ }
  return null;
}

async function destination(endpoint: string, resolve: PushResolver): Promise<{ url: URL; address: Address }> {
  const normalized = pushEndpoint(endpoint);
  if (!normalized) throw new Error('Invalid push destination');
  const url = new URL(normalized);
  if (url.port && url.port !== '443') throw new Error('Push destination must use HTTPS port 443');
  const hostname = url.hostname.replace(/^\[|\]$/gu, '');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([
      isIP(hostname) ? Promise.resolve([{ address: hostname, family: isIP(hostname) }]) : resolve(hostname),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Push DNS deadline')), 5_000); }),
    ]);
    if (!addresses.length || !addresses.every((item) => (item.family === 4 || item.family === 6) && publicPushAddress(item.address))) throw new Error('Push destination is not public');
    return { url, address: addresses[0]! };
  } finally { if (timer) clearTimeout(timer); }
}

export async function postPush(url: URL, address: Address, details: webPush.RequestDetails, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, {
      method: 'POST', headers: details.headers, agent: false, family: address.family,
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    }, (response) => {
      const status = response.statusCode ?? 0;
      response.destroy();
      resolve(status);
    });
    outgoing.on('error', () => reject(new Error('Push HTTPS request failed')));
    outgoing.end(details.body);
  });
}

export async function sendEncryptedPush(input: {
  subscription: PushSubscriptionRecord; vapid: PushDocument['vapid']; subject: string; payload: string;
  resolve?: PushResolver; post?: PushPost;
  beforeDispatch?: () => Promise<boolean> | boolean;
  signal?: AbortSignal;
}): Promise<number> {
  if (Buffer.byteLength(input.payload) > 3_000) throw new Error('Push payload exceeds limit');
  const subject = pushSubject(input.subject);
  if (!subject) throw new Error('Push subject is invalid');
  if (input.signal?.aborted) return 0;
  const target = await destination(input.subscription.endpoint, input.resolve ?? ((host) => lookup(host, { all: true })));
  const details = webPush.generateRequestDetails(input.subscription, input.payload, {
    vapidDetails: { subject, ...input.vapid }, contentEncoding: 'aes128gcm', TTL: 300, urgency: 'normal',
  });
  if (input.signal?.aborted || (input.beforeDispatch && !await input.beforeDispatch())) return 0;
  return (input.post ?? postPush)(target.url, target.address, details, input.signal);
}
