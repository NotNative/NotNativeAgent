// SPDX-License-Identifier: Apache-2.0
import { createECDH, randomUUID, timingSafeEqual } from 'node:crypto';
import { open, readFile, rename, mkdir, unlink, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { withConfigLock } from '../scheduled/config-lock.ts';
import { OWNER_LIMIT, SUBSCRIPTION_LIMIT, validPushDocument, type PushDocument, type PushSubscriptionRecord } from './subscription-schema.ts';

const MAX_BYTES = 1_048_576;
export class PushStoreError extends Error {
  constructor(message: string, readonly status: number = 503) { super(message); }
}

export class PushSubscriptionStore {
  constructor(readonly path: string) {}
  async publicKey(): Promise<string> { return (await this.change(() => undefined)).vapid.publicKey; }
  async snapshot(): Promise<PushDocument> { return withConfigLock(this.path, () => readDocument(this.path)); }
  async current(entry: PushSubscriptionRecord): Promise<boolean> {
    const doc = await this.snapshot();
    return doc.subscriptions.some((item) => JSON.stringify(item) === JSON.stringify(entry));
  }
  async removeExpired(entry: PushSubscriptionRecord): Promise<void> {
    await this.change((doc) => {
      doc.subscriptions = doc.subscriptions.filter((item) => item.endpoint !== entry.endpoint || item.owner !== entry.owner
        || item.updatedAt !== entry.updatedAt || item.keys.p256dh !== entry.keys.p256dh || item.keys.auth !== entry.keys.auth
        || JSON.stringify(item.authority) !== JSON.stringify(entry.authority));
    });
  }
  async subscribe(entry: PushSubscriptionRecord): Promise<void> {
    await this.change((doc) => {
      const existing = doc.subscriptions.find((item) => item.endpoint === entry.endpoint);
      const changesOwner = existing !== undefined && existing.owner !== entry.owner;
      if (changesOwner && (existing.keys.p256dh !== entry.keys.p256dh
        || !timingSafeEqual(Buffer.from(existing.keys.auth, 'base64url'), Buffer.from(entry.keys.auth, 'base64url')))) {
        throw new PushStoreError('Subscription belongs to another UI credential', 409);
      }
      if ((!existing && doc.subscriptions.length >= SUBSCRIPTION_LIMIT)
        || ((!existing || changesOwner) && doc.subscriptions.filter((item) => item.owner === entry.owner).length >= OWNER_LIMIT)) {
        throw new PushStoreError('Push subscription capacity reached', 409);
      }
      doc.subscriptions = doc.subscriptions.filter((item) => item.endpoint !== entry.endpoint);
      doc.subscriptions.push(entry);
    });
  }
  async unsubscribe(owner: string, endpoint: string): Promise<void> {
    await this.change((doc) => { doc.subscriptions = doc.subscriptions.filter((item) => item.owner !== owner || item.endpoint !== endpoint); });
  }
  private async change(update: (doc: PushDocument) => void): Promise<PushDocument> {
    return withConfigLock(this.path, async () => {
      const doc = await readDocument(this.path);
      update(doc);
      await writeDocument(this.path, doc);
      return doc;
    });
  }
}

async function readDocument(path: string): Promise<PushDocument> {
  try {
    if ((await stat(path)).size > MAX_BYTES) throw new PushStoreError('Push store exceeds its size limit');
    const doc: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!validPushDocument(doc)) throw new PushStoreError('Push store is invalid');
    return doc;
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw new PushStoreError('Push store cannot be read');
    const pair = createECDH('prime256v1'); pair.generateKeys();
    const scalar = pair.getPrivateKey();
    const privateKey = Buffer.concat([Buffer.alloc(32 - scalar.length), scalar]).toString('base64url');
    return { version: 1, vapid: { publicKey: pair.getPublicKey().toString('base64url'), privateKey }, subscriptions: [] };
  }
}

async function writeDocument(path: string, doc: PushDocument): Promise<void> {
  const text = JSON.stringify(doc);
  if (Buffer.byteLength(text) > MAX_BYTES) throw new PushStoreError('Push store exceeds its size limit');
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, path);
  } finally { await unlink(temp).catch((error: { code?: string }) => { if (error.code !== 'ENOENT') throw error; }); }
}
