// SPDX-License-Identifier: Apache-2.0
import { createECDH, createDecipheriv, hkdfSync, createPublicKey, verify } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { postPush, publicPushAddress, pushSubject, sendEncryptedPush } from '../push/transport.ts';
import type { PushSubscriptionRecord } from '../push/subscription-schema.ts';

const httpsRequest = vi.hoisted(() => vi.fn());
vi.mock('node:https', () => ({ request: httpsRequest }));

function fixture() {
  const client = createECDH('prime256v1'); client.generateKeys();
  const server = createECDH('prime256v1'); server.generateKeys();
  const auth = Buffer.alloc(16, 7);
  const entry: PushSubscriptionRecord = { endpoint: 'https://push.example/send/one', keys: { p256dh: client.getPublicKey().toString('base64url'), auth: auth.toString('base64url') }, owner: 'a'.repeat(64), updatedAt: 1 };
  const scalar = server.getPrivateKey();
  const vapid = { publicKey: server.getPublicKey().toString('base64url'), privateKey: Buffer.concat([Buffer.alloc(32 - scalar.length), scalar]).toString('base64url') };
  return { client, server, auth, entry, vapid };
}

describe('encrypted Web Push transport', () => {
  it('produces a decryptable aes128gcm record and valid origin-bound ES256 VAPID assertion', async () => {
    const item = fixture(); const payload = '{"title":"Agent finished","body":"done"}';
    const post = vi.fn(async (_url, _address, details) => {
      const record = details.body as Buffer;
      expect(record.includes(Buffer.from(payload))).toBe(false);
      expect(details.headers['Content-Encoding']).toBe('aes128gcm');
      expect(details.headers.TTL).toBe(300);
      const salt = record.subarray(0, 16); const key = record.subarray(21, 21 + record[20]!);
      const shared = item.client.computeSecret(key);
      const info = Buffer.concat([Buffer.from('WebPush: info\0'), item.client.getPublicKey(), key]);
      const ikm = hkdfSync('sha256', shared, item.auth, info, 32);
      const cek = hkdfSync('sha256', Buffer.from(ikm), salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
      const nonce = hkdfSync('sha256', Buffer.from(ikm), salt, Buffer.from('Content-Encoding: nonce\0'), 12);
      const encrypted = record.subarray(21 + key.length);
      const decipher = createDecipheriv('aes-128-gcm', Buffer.from(cek), Buffer.from(nonce));
      decipher.setAuthTag(encrypted.subarray(-16));
      const plain = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
      expect(plain.subarray(0, -1).toString()).toBe(payload); expect(plain.at(-1)).toBe(2);
      const token = String(details.headers.Authorization).match(/^vapid t=([^,]+), k=/u)![1]!;
      const [head, body, signature] = token.split('.') as [string, string, string];
      const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
      expect(claims.aud).toBe('https://push.example'); expect(claims.sub).toBe('mailto:operator@example.com');
      expect(claims.exp).toBeGreaterThan(Date.now() / 1_000);
      expect(claims.exp).toBeLessThanOrEqual(Date.now() / 1_000 + 86_400);
      const publicBytes = item.server.getPublicKey();
      const publicKey = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: publicBytes.subarray(1, 33).toString('base64url'), y: publicBytes.subarray(33).toString('base64url') } });
      expect(verify('sha256', Buffer.from(`${head}.${body}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))).toBe(true);
      return 201;
    });
    expect(await sendEncryptedPush({ subscription: item.entry, vapid: item.vapid, subject: 'mailto:operator@example.com', payload,
      resolve: async () => [{ address: '8.8.8.8', family: 4 }], post })).toBe(201);
    expect(post.mock.calls[0]![1]).toEqual({ address: '8.8.8.8', family: 4 });
  });

  it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '192.0.2.1', '::1', 'fc00::1', '::ffff:127.0.0.1', '64:ff9b::a00:1', '2001:db8::1', '4000::1'])('rejects nonpublic address %s', (address) => {
    expect(publicPushAddress(address)).toBe(false);
  });

  it('rejects mixed public/private DNS answers before encryption/post', async () => {
    const item = fixture(); const post = vi.fn();
    await expect(sendEncryptedPush({ subscription: item.entry, vapid: item.vapid, subject: 'https://operator.example', payload: 'safe',
      resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }], post })).rejects.toThrow('not public');
    expect(post).not.toHaveBeenCalled();
  });

  it('bounds DNS waits and payload size', async () => {
    vi.useFakeTimers(); const item = fixture(); const post = vi.fn();
    try {
      const task = sendEncryptedPush({ subscription: item.entry, vapid: item.vapid, subject: 'https://operator.example', payload: 'safe', resolve: () => new Promise(() => {}), post });
      const rejected = expect(task).rejects.toThrow('DNS deadline');
      await vi.advanceTimersByTimeAsync(5_000); await rejected;
      await expect(sendEncryptedPush({ subscription: item.entry, vapid: item.vapid, subject: 'https://operator.example', payload: 'x'.repeat(3_001), post })).rejects.toThrow('limit');
      expect(post).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it.each(['http://operator.example', 'https://user:secret@operator.example', 'https://localhost', 'mailto:invalid', 'https://operator.example/?token=secret'])('rejects unsafe subject %s', (subject) => {
    expect(pushSubject(subject)).toBeNull();
  });

  it('pins HTTPS DNS resolution while preserving the endpoint hostname and returns redirects without following them', async () => {
    const outgoing = Object.assign(new EventEmitter(), { end: vi.fn() });
    let responseCallback: (response: { statusCode: number; destroy: () => void }) => void = () => {};
    httpsRequest.mockImplementationOnce((_url, _options, callback) => { responseCallback = callback; return outgoing; });
    const details: Parameters<typeof postPush>[2] = { method: 'POST', endpoint: 'https://push.example/send/one', headers: { Authorization: 'vapid assertion' }, body: Buffer.from('encrypted') };
    const url = new URL('https://push.example/send/one');
    const task = postPush(url, { address: '8.8.8.8', family: 4 }, details);
    const options = httpsRequest.mock.lastCall![1];
    expect(httpsRequest.mock.lastCall![0]).toBe(url);
    expect(options).toMatchObject({ method: 'POST', agent: false, family: 4, headers: details.headers });
    const resolved = vi.fn(); options.lookup('push.example', {}, resolved);
    expect(resolved).toHaveBeenCalledWith(null, '8.8.8.8', 4);
    expect(outgoing.end).toHaveBeenCalledWith(details.body);
    const destroy = vi.fn(); responseCallback({ statusCode: 307, destroy });
    expect(await task).toBe(307); expect(destroy).toHaveBeenCalledOnce();
  });

  it('bounds HTTPS requests and combines external cancellation without exposing request errors', async () => {
    const deadline = new AbortController(); const cancellation = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    try {
      for (const controller of [cancellation, deadline]) {
        const outgoing = Object.assign(new EventEmitter(), { end: vi.fn() });
        httpsRequest.mockImplementationOnce((_url, options) => {
          options.signal.addEventListener('abort', () => outgoing.emit('error', new Error('endpoint token is secret')));
          return outgoing;
        });
        const task = postPush(new URL('https://push.example/send/secret'), { address: '8.8.8.8', family: 4 }, { method: 'POST', endpoint: 'https://push.example/send/secret', headers: {}, body: Buffer.from('encrypted') }, controller === cancellation ? cancellation.signal : undefined);
        const rejection = expect(task).rejects.toThrow(/^Push HTTPS request failed$/u);
        controller.abort(); await rejection;
      }
      expect(timeout).toHaveBeenCalledWith(10_000);
    } finally { timeout.mockRestore(); }
  });

  it('does not dispatch when cancelled or when the final governance check denies delivery', async () => {
    const item = fixture(); const post = vi.fn(); const resolver = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]);
    const input = { subscription: item.entry, vapid: item.vapid, subject: 'mailto:operator@example.com', payload: 'safe', resolve: resolver, post };
    const cancelled = new AbortController(); cancelled.abort();
    expect(await sendEncryptedPush({ ...input, signal: cancelled.signal })).toBe(0);
    expect(resolver).not.toHaveBeenCalled();
    const beforeDispatch = vi.fn(async () => false);
    expect(await sendEncryptedPush({ ...input, beforeDispatch })).toBe(0);
    expect(beforeDispatch).toHaveBeenCalledOnce(); expect(post).not.toHaveBeenCalled();
  });
});
