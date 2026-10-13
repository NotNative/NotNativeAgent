// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes } from 'node:crypto';
import type { JwtSecretHolder } from './jwt.ts';
export interface NativeUiIdentity { installationId: string; dataId: string; generation: string; origin: string }
export class NativeUiBootstrap {
  readonly identity: Readonly<NativeUiIdentity>;
  readonly jwt: JwtSecretHolder;
  closed = false;
  private readonly tickets = new Map<string, { issued: number; expires: number }>();
  constructor(identity: NativeUiIdentity, private readonly now: () => number) {
    const url = new URL(identity.origin);
    if (!/^nna_[a-f0-9]{64}$/u.test(identity.installationId) || !/^data_[a-f0-9]{64}$/u.test(identity.dataId)
      || !/^[A-Za-z0-9_-]{1,128}$/u.test(identity.generation) || url.protocol !== 'http:'
      || !['127.0.0.1', '[::1]'].includes(url.hostname) || identity.origin !== url.origin) throw new Error('Invalid native UI identity');
    this.identity = Object.freeze({ ...identity });
    let secret = randomBytes(32).toString('hex');
    this.jwt = { secret: () => secret, source: () => 'memory', rotate: () => { secret = randomBytes(32).toString('hex'); } };
  }
  allowed(headers: Headers, url: URL): boolean {
    return !this.closed && url.origin === this.identity.origin
      && (headers.get('host') === null || headers.get('host') === url.host)
      && (headers.get('origin') === null || headers.get('origin') === this.identity.origin)
      && ![...headers.keys()].some((key) => key === 'forwarded' || key.startsWith('x-forwarded-'));
  }
  issueTicket(): { ticket: string; expiresAt: string } {
    if (this.closed) throw new Error('Native UI authentication is closed');
    const now = this.now();
    for (const [key, value] of this.tickets) if (value.expires <= now || now < value.issued) this.tickets.delete(key);
    if (this.tickets.size >= 16) throw new Error('Native UI ticket capacity reached');
    const ticket = randomBytes(32).toString('base64url');
    this.tickets.set(this.hash(ticket), { issued: now, expires: now + 60000 });
    return { ticket, expiresAt: new Date(now + 60000).toISOString() };
  }
  consume(body: unknown, headers: Headers, url: URL, peer?: string): boolean {
    if (!this.allowed(headers, url) || headers.get('origin') !== this.identity.origin
      || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer ?? '')) return false;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1
      || !Object.hasOwn(body, 'ticket')) return false;
    const ticket = (body as { ticket: unknown }).ticket;
    if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(ticket)) return false;
    const key = this.hash(ticket);
    const value = this.tickets.get(key);
    this.tickets.delete(key);
    return value !== undefined && this.now() >= value.issued && this.now() < value.expires;
  }
  invalidate(): void { this.tickets.clear(); this.jwt.rotate(); }
  close(): void { this.closed = true; this.invalidate(); }
  private hash(ticket: string): string { return createHash('sha256').update(ticket).digest('hex'); }
}
