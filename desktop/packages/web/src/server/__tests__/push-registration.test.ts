// SPDX-License-Identifier: Apache-2.0
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createECDH, createHash } from 'node:crypto';

const shortKeys = vi.hoisted(() => ({ enabled: false }));
vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof import('node:crypto')>();
  return { ...actual, createECDH: (curve: string) => {
    const pair = actual.createECDH(curve);
    if (shortKeys.enabled) pair.generateKeys = (() => {
      pair.setPrivateKey(Buffer.from([1]));
      return pair.getPublicKey();
    }) as typeof pair.generateKeys;
    return pair;
  } };
});

const root = mkdtempSync(join(tmpdir(), 'nnd-push-registration-'));
const previousDir = process.env.NOTNATIVE_DATA_DIR;
const previousPassword = process.env.NOTNATIVE_UI_PASSWORD;
process.env.NOTNATIVE_DATA_DIR = root;
const { createPushRoutes, pushCredentialOwner } = await import('../push/routes.ts');
const { PushSubscriptionStore } = await import('../push/subscription-store.ts');
const { pushSubscription, validPushDocument } = await import('../push/subscription-schema.ts');
const { getUiAuthController, resetUiAuthForTests } = await import('../lib/auth/ui-auth.ts');
const owner = 'a'.repeat(64);
let sequence = 0;
const path = () => join(root, `push-${sequence++}.json`);
function subscription(endpoint = 'https://push.example/send/one') {
  const pair = createECDH('prime256v1'); pair.generateKeys();
  return { endpoint, keys: { p256dh: pair.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 7).toString('base64url') } };
}
function request(url: string, method = 'GET', body?: unknown) {
  return new Request(`http://local${url}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function document(file: string) { return JSON.parse(readFileSync(file, 'utf8')); }
afterEach(() => { shortKeys.enabled = false; });
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (previousDir === undefined) delete process.env.NOTNATIVE_DATA_DIR; else process.env.NOTNATIVE_DATA_DIR = previousDir;
  if (previousPassword === undefined) delete process.env.NOTNATIVE_UI_PASSWORD; else process.env.NOTNATIVE_UI_PASSWORD = previousPassword;
  resetUiAuthForTests();
});

describe('durable Web Push registration', () => {
  it('pads short private scalars and preserves the same key after reload', async () => {
    const file = path(); shortKeys.enabled = true;
    const key = await new PushSubscriptionStore(file).publicKey();
    expect(Buffer.from(document(file).vapid.privateKey, 'base64url')).toHaveLength(32);
    shortKeys.enabled = false;
    expect(await new PushSubscriptionStore(file).publicKey()).toBe(key);
    expect(validPushDocument(document(file))).toBe(true);
  });
  it('serializes independent writers without losing keys or registrations', async () => {
    const file = path();
    const stores = Array.from({ length: 5 }, () => new PushSubscriptionStore(file));
    const publicKeys = await Promise.all(stores.map((store) => store.publicKey()));
    expect(new Set(publicKeys).size).toBe(1);
    await Promise.all(stores.map((store, index) => store.subscribe(pushSubscription(subscription(`https://push.example/${index}`), owner, index)!)));
    expect(document(file).subscriptions).toHaveLength(5);
    expect(readdirSync(root).filter((entry) => entry.startsWith(file.split(/[\\/]/u).at(-1)!) && entry !== file.split(/[\\/]/u).at(-1))).toEqual([]);
  });
  it('does not rotate keys or overwrite a corrupt store', async () => {
    const file = path(); writeFileSync(file, '{broken');
    await expect(new PushSubscriptionStore(file).publicKey()).rejects.toThrow('Push store cannot be read');
    expect(readFileSync(file, 'utf8')).toBe('{broken');
  });
  it('enforces owner isolation and per-owner capacity while allowing refresh', async () => {
    const file = path(); const store = new PushSubscriptionStore(file);
    const first = pushSubscription(subscription(), owner, 1)!;
    await store.subscribe(first);
    await expect(store.subscribe({ ...first, owner: 'b'.repeat(64), keys: { ...first.keys, auth: Buffer.alloc(16, 8).toString('base64url') } })).rejects.toMatchObject({ status: 409 });
    await store.unsubscribe('b'.repeat(64), first.endpoint);
    expect(document(file).subscriptions).toHaveLength(1);
    for (let index = 1; index < 8; index++) await store.subscribe(pushSubscription(subscription(`https://push.example/${index}`), owner, index)!);
    await expect(store.subscribe(pushSubscription(subscription('https://push.example/ninth'), owner, 9)!)).rejects.toMatchObject({ status: 409 });
    await store.subscribe({ ...first, updatedAt: 10 });
    expect(document(file).subscriptions).toHaveLength(8);
    await store.unsubscribe(owner, first.endpoint);
    expect(document(file).subscriptions).toHaveLength(7);
  });
  it('rebinds the browser subscription on reauthentication only with both original keys', async () => {
    const file = path(); const store = new PushSubscriptionStore(file);
    const first = pushSubscription(subscription(), owner, 1)!;
    const nextOwner = 'b'.repeat(64);
    await store.subscribe(first);
    const changedPublicKey = subscription().keys.p256dh;
    await expect(store.subscribe({ ...first, owner: nextOwner, keys: { ...first.keys, p256dh: changedPublicKey } })).rejects.toMatchObject({ status: 409 });
    await store.subscribe({ ...first, owner: nextOwner, updatedAt: 2 });
    expect(document(file).subscriptions).toEqual([{ ...first, owner: nextOwner, updatedAt: 2 }]);
    await store.unsubscribe(owner, first.endpoint);
    expect(document(file).subscriptions).toHaveLength(1);
    await store.unsubscribe(nextOwner, first.endpoint);
    expect(document(file).subscriptions).toHaveLength(0);
  });
  it('applies the target owner capacity during reauthentication', async () => {
    const file = path(); const store = new PushSubscriptionStore(file);
    const first = pushSubscription(subscription(), owner, 1)!;
    await store.subscribe(first);
    const nextOwner = 'b'.repeat(64);
    for (let index = 0; index < 8; index++) await store.subscribe(pushSubscription(subscription(`https://push.example/new-${index}`), nextOwner, index)!);
    await expect(store.subscribe({ ...first, owner: nextOwner })).rejects.toMatchObject({ status: 409 });
    expect(validPushDocument(document(file))).toBe(true);
    expect(document(file).subscriptions.find((entry: { endpoint: string }) => entry.endpoint === first.endpoint).owner).toBe(owner);
  });
});

describe('registration validation and visibility lease', () => {
  it.each(['http://push.example/a', 'https://user:pass@push.example/a', 'https://push.example/a#fragment', 'bad'])('rejects unsafe endpoint %s', (endpoint) => {
    expect(pushSubscription(subscription(endpoint), owner, 1)).toBeNull();
  });
  it('rejects invalid curve points and wrong authentication secret lengths', () => {
    const input = subscription();
    expect(pushSubscription({ ...input, keys: { ...input.keys, p256dh: Buffer.alloc(65, 4).toString('base64url') } }, owner, 1)).toBeNull();
    expect(pushSubscription({ ...input, keys: { ...input.keys, auth: Buffer.alloc(15).toString('base64url') } }, owner, 1)).toBeNull();
  });
  it('rejects absent credentials before reading or writing registration', async () => {
    const store = new PushSubscriptionStore(path());
    const app = createPushRoutes({ store, owner: () => null });
    expect((await app.fetch(request('/api/push/subscribe', 'POST', subscription()))).status).toBe(401);
    expect(readdirSync(root)).not.toContain(store.path.split(/[\\/]/u).at(-1));
  });
  it('captures one authenticated owner so a credential change cannot persist an invalid document', async () => {
    const store = new PushSubscriptionStore(path());
    let calls = 0;
    const app = createPushRoutes({ store, owner: () => ++calls === 1 ? owner : null });
    expect((await app.fetch(request('/api/push/subscribe', 'POST', subscription()))).status).toBe(200);
    expect(calls).toBe(1);
    expect(validPushDocument(document(store.path))).toBe(true);
  });
  it.each([null, [], { endpoint: 'https://push.example' }, { padding: 'x'.repeat(17_000) }])('returns 400 for invalid or oversized bodies', async (body) => {
    const app = createPushRoutes({ store: new PushSubscriptionStore(path()), owner: () => owner });
    expect((await app.fetch(request('/api/push/subscribe', 'POST', body))).status).toBe(400);
  });
  it('expires visibility and keeps each owner separate', async () => {
    let now = 100; let current = owner;
    const app = createPushRoutes({ store: new PushSubscriptionStore(path()), owner: () => current, now: () => now });
    const visible = async () => ((await (await app.fetch(request('/api/push/visibility'))).json()) as { visible: boolean }).visible;
    expect(await visible()).toBe(false);
    expect((await app.fetch(request('/api/push/visibility', 'POST', { visible: true }))).status).toBe(200);
    expect(await visible()).toBe(true);
    current = 'b'.repeat(64); expect(await visible()).toBe(false);
    current = owner; now += 30_000; expect(await visible()).toBe(false);
    expect((await app.fetch(request('/api/push/visibility'))).headers.get('cache-control')).toBe('no-store');
    await app.fetch(request('/api/push/visibility', 'POST', { visible: true }));
    await app.fetch(request('/api/push/visibility', 'POST', { visible: false }));
    expect(await visible()).toBe(false);
    expect((await app.fetch(request('/api/push/visibility', 'POST', { visible: 'true' }))).status).toBe(400);
  });
});

describe('actual createApp authentication ordering', () => {
  it('gates VAPID discovery and requires real credentials for mutations even in open mode', async () => {
    process.env.NOTNATIVE_UI_PASSWORD = 'push-test-password'; resetUiAuthForTests();
    const { createApp } = await import('../app.ts'); const app = createApp();
    expect((await app.fetch(request('/api/push/vapid-public-key'))).status).toBe(401);
    delete process.env.NOTNATIVE_UI_PASSWORD;
    const publicResponse = await app.fetch(request('/api/push/vapid-public-key'));
    expect(publicResponse.status).toBe(200);
    expect(Object.keys(await publicResponse.json() as object)).toEqual(['publicKey']);
    expect((await app.fetch(request('/api/push/subscribe', 'POST', subscription()))).status).toBe(401);
    const token = getUiAuthController().issueSessionToken(60_000).token;
    const authenticated = request('/api/push/subscribe', 'POST', subscription());
    authenticated.headers.set('cookie', `oc_ui_session=${token}`);
    expect(pushCredentialOwner(authenticated)).toBe(createHash('sha256').update(`session:${token}`).digest('hex'));
    expect((await app.fetch(authenticated)).status).toBe(200);
    const invalidBearer = request('/api/push/visibility');
    invalidBearer.headers.set('authorization', 'Bearer invalid');
    invalidBearer.headers.set('cookie', `oc_ui_session=${token}`);
    expect((await app.fetch(invalidBearer)).status).toBe(401);
  });
  it('accepts durable client credentials with a different owner and denies revoked credentials', async () => {
    const { RemoteClientStore } = await import('../lib/auth/remote-clients.ts');
    const clients = new RemoteClientStore(root);
    const created = clients.createClient({ clientKind: 'mobile' });
    resetUiAuthForTests();
    const { createApp } = await import('../app.ts'); const app = createApp();
    const registration = request('/api/push/subscribe', 'POST', subscription('https://push.example/client'));
    registration.headers.set('authorization', `Bearer ${created.token}`);
    expect(pushCredentialOwner(registration)).toBe(createHash('sha256').update(`client:${created.client.id}`).digest('hex'));
    expect((await app.fetch(registration)).status).toBe(200);
    const stored = document(join(root, 'push-subscriptions.json'));
    expect(stored.subscriptions.some((entry: { owner: string }) => entry.owner === createHash('sha256').update(`client:${created.client.id}`).digest('hex'))).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(created.token);
    // The controller's credential source is reloaded at server restart.
    const records = JSON.parse(readFileSync(join(root, 'remote-clients.json'), 'utf8'));
    records.clients.find((client: { id: string }) => client.id === created.client.id).revokedAt = new Date().toISOString();
    writeFileSync(join(root, 'remote-clients.json'), JSON.stringify(records));
    resetUiAuthForTests();
    const revoked = request('/api/push/visibility'); revoked.headers.set('authorization', `Bearer ${created.token}`);
    expect((await app.fetch(revoked)).status).toBe(401);
  });
});
