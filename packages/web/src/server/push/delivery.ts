// SPDX-License-Identifier: Apache-2.0
import { pushAuthorityActive } from './authority.ts';
import { sendEncryptedPush, pushSubject } from './transport.ts';
import type { PushSubscriptionStore } from './subscription-store.ts';
import type { PushSubscriptionRecord } from './subscription-schema.ts';
import type { PushVisibility } from './visibility.ts';

export class PushDelivery {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private readonly controller = new AbortController();
  constructor(private readonly input: {
    store: PushSubscriptionStore; visibility: PushVisibility; subject: () => string | null;
    authorized?: (entry: PushSubscriptionRecord) => boolean; send?: typeof sendEncryptedPush;
  }) {}
  dispose(): void { this.controller.abort(); }
  async deliver(notification: { title: string; body: string; tag?: string }, eligible: () => boolean = () => true): Promise<{ sent: number; failed: number; skipped: number }> {
    if (this.controller.signal.aborted || this.pending >= 32) return { sent: 0, failed: 0, skipped: 1 };
    this.pending += 1;
    const task = this.tail.then(() => this.deliverNow(notification, eligible));
    this.tail = task.catch(() => undefined);
    try { return await task; } finally { this.pending -= 1; }
  }
  private async deliverNow(notification: { title: string; body: string; tag?: string }, eligible: () => boolean) {
    const subject = pushSubject(this.input.subject());
    if (!subject || this.controller.signal.aborted || !eligible()) return { sent: 0, failed: 0, skipped: 1 };
    const clean = (value: string, limit: number) => value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, limit);
    const payload = JSON.stringify({ title: clean(notification.title, 120), body: clean(notification.body, 500), tag: notification.tag ? clean(notification.tag, 200) : undefined });
    const doc = await this.input.store.snapshot();
    const result = { sent: 0, failed: 0, skipped: 0 };
    let cursor = 0;
    const run = async () => {
      while (cursor < doc.subscriptions.length) {
        const entry = doc.subscriptions[cursor++]!;
        const allowed = () => !this.controller.signal.aborted && eligible()
          && (this.input.authorized?.(entry) ?? pushAuthorityActive(entry.authority)) && !this.input.visibility.anyVisible();
        if (!allowed()) { result.skipped += 1; continue; }
        try {
          const status = await (this.input.send ?? sendEncryptedPush)({ subscription: entry, vapid: doc.vapid, subject, payload,
            beforeDispatch: async () => (await this.input.store.current(entry)) && allowed(), signal: this.controller.signal });
          if (status === 404 || status === 410) await this.input.store.removeExpired(entry);
          if (status === 0) result.skipped += 1;
          else if (status >= 200 && status < 300) result.sent += 1; else result.failed += 1;
        } catch { result.failed += 1; }
      }
    };
    await Promise.all(Array.from({ length: 4 }, run));
    return result;
  }
}
