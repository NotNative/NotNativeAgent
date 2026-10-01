// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createECDH } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { PushSubscriptionStore } from '../push/subscription-store.ts';
import { PushVisibility } from '../push/visibility.ts';
import { PushDelivery } from '../push/delivery.ts';
import { pushSubscription } from '../push/subscription-schema.ts';

const root = mkdtempSync(join(tmpdir(), 'nnd-push-delivery-'));
let next = 0;
afterAll(() => rmSync(root, { recursive: true, force: true }));
async function fixture(count = 1) {
  const store = new PushSubscriptionStore(join(root, `${next++}.json`)); const visibility = new PushVisibility();
  for (let index = 0; index < count; index += 1) {
    const pair = createECDH('prime256v1'); pair.generateKeys();
    await store.subscribe(pushSubscription({ endpoint: `https://push.example/${index}`, keys: {
      p256dh: pair.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 7).toString('base64url'),
    } }, 'a'.repeat(64), index)!);
  }
  return { store, visibility };
}

describe('push delivery lifecycle', () => {
  it('transmits valid session identity and omits invalid identities', async () => {
    const item = await fixture(); const send = vi.fn().mockResolvedValue(201);
    const runtime = new PushDelivery({ ...item, authorized: () => true, subject: () => 'mailto:operator@example.com', send });
    await runtime.deliver({ title: 'title', body: 'body', sessionId: 's/a' });
    expect(JSON.parse(send.mock.calls[0]![0].payload).sessionId).toBe('s/a');
    await runtime.deliver({ title: 'title', body: 'body', sessionId: 's1\n' });
    expect(JSON.parse(send.mock.calls[1]![0].payload)).not.toHaveProperty('sessionId');
  });
  it('suppresses every destination while any interactive client is visible and excludes legacy authority by default', async () => {
    const item = await fixture(); const send = vi.fn().mockResolvedValue(201);
    const legacy = new PushDelivery({ ...item, subject: () => 'mailto:operator@example.com', send });
    expect((await legacy.deliver({ title: 'title', body: 'body' })).skipped).toBe(1);
    const allowed = new PushDelivery({ ...item, authorized: () => true, subject: () => 'mailto:operator@example.com', send });
    item.visibility.update('other-owner', { visible: true });
    expect((await allowed.deliver({ title: 'title', body: 'body' })).skipped).toBe(1);
    expect(send).not.toHaveBeenCalled();
    item.visibility.update('other-owner', { visible: false });
    expect((await allowed.deliver({ title: 'title', body: 'body' })).sent).toBe(1);
  });

  it('removes expired destinations without removing a concurrently replaced registration', async () => {
    const item = await fixture(2);
    const send = vi.fn(async ({ subscription }) => {
      if (subscription.endpoint.endsWith('/0')) return 410;
      await item.store.subscribe({ ...subscription, updatedAt: 100 }); return 404;
    });
    const runtime = new PushDelivery({ ...item, authorized: () => true, subject: () => 'mailto:operator@example.com', send });
    expect((await runtime.deliver({ title: 'title', body: 'body' })).failed).toBe(2);
    const remaining = (await item.store.snapshot()).subscriptions;
    expect(remaining).toHaveLength(1); expect(remaining[0]!.updatedAt).toBe(100);
  });

  it('rechecks unsubscribe, credential authority and visibility immediately before dispatch', async () => {
    const item = await fixture(); let active = true;
    const send = vi.fn(async (input) => {
      active = false; expect(await input.beforeDispatch()).toBe(false);
      active = true; item.visibility.update('another-owner', { visible: true }); expect(await input.beforeDispatch()).toBe(false);
      item.visibility.update('another-owner', { visible: false });
      await item.store.unsubscribe(input.subscription.owner, input.subscription.endpoint);
      expect(await input.beforeDispatch()).toBe(false);
      return 0;
    });
    const runtime = new PushDelivery({ ...item, authorized: () => active, subject: () => 'mailto:operator@example.com', send });
    expect((await runtime.deliver({ title: 'title', body: 'body' })).skipped).toBe(1);
  });

  it('queues concurrent notifications, limits destination concurrency to four, and stops after disposal', async () => {
    const item = await fixture(8); let running = 0; let highest = 0;
    const send = vi.fn(async () => { running += 1; highest = Math.max(highest, running); await new Promise((resolve) => setTimeout(resolve, 2)); running -= 1; return 201; });
    const runtime = new PushDelivery({ ...item, authorized: () => true, subject: () => 'mailto:operator@example.com', send });
    const results = await Promise.all([runtime.deliver({ title: 'first', body: 'body' }), runtime.deliver({ title: 'second', body: 'body' })]);
    expect(results.map((result) => result.sent)).toEqual([8, 8]); expect(highest).toBe(4);
    runtime.dispose(); expect((await runtime.deliver({ title: 'third', body: 'body' })).skipped).toBe(1);
    expect(send).toHaveBeenCalledTimes(16);
  });

  it('rechecks preferences after queuing and immediately before dispatch', async () => {
    const item = await fixture(); let enabled = true;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const send = vi.fn(async (input) => {
      await blocked;
      return await input.beforeDispatch() ? 201 : 0;
    });
    const runtime = new PushDelivery({ ...item, authorized: () => true, subject: () => 'mailto:operator@example.com', send });
    const first = runtime.deliver({ title: 'first', body: 'body' }, () => enabled);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    const second = runtime.deliver({ title: 'second', body: 'body' }, () => enabled);
    enabled = false; release();
    expect((await first).skipped).toBe(1);
    expect((await second).skipped).toBe(1);
    expect(send).toHaveBeenCalledOnce();
  });
});
