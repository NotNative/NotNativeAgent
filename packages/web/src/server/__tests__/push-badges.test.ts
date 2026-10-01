// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { PushBadges } from '../push/badge-state.ts';
import { createPushRoutes } from '../push/routes.ts';

describe('credential-owned notification badges', () => {
  it('remembers resets before an owner receives its first mark and only invalidates that session', () => {
    const badges = new PushBadges(); const queued = badges.checkpoint();
    badges.clear('a', 's1');
    expect(badges.markQueued('a', 's1', queued)).toBeNull();
    const other = badges.markQueued('a', 's2', queued)!;
    badges.clear('a', 's1'); expect(badges.current(other)).toBe(true);
    badges.clear('a'); expect(badges.current(other)).toBe(false);
    expect(badges.markQueued('a', 's3', queued)).toBeNull();
  });
  it('counts by session, isolates owners, and invalidates delivery tickets after reset', () => {
    const badges = new PushBadges();
    const ticket = badges.mark('a', 's1'); badges.mark('a', 's2'); badges.mark('b', 's1');
    expect(badges.snapshot('a').count).toBe(2);
    const cleared = badges.clear('a', 's1');
    expect(cleared.count).toBe(1); expect(cleared.revision).toBeGreaterThan(ticket.snapshot.revision);
    expect(badges.current(ticket)).toBe(false); expect(badges.snapshot('b').count).toBe(1);
    expect(badges.clear('a').count).toBe(0);
    expect(new PushBadges().snapshot('a').epoch).not.toBe(cleared.epoch);
  });
  it('bounds retained owners and sessions and rejects tickets for evicted state', () => {
    const badges = new PushBadges(); const ticket = badges.mark('first', 's');
    for (let index = 0; index < 1000; index++) badges.mark(`owner-${index}`, 's');
    expect(badges.current(ticket)).toBe(false);
    for (let index = 0; index < 300; index++) badges.mark('many', `s${index}`);
    expect(badges.snapshot('many').count).toBe(256);
  });
  it('authenticates reads and resets, validates bodies, and clears only the credential owner', async () => {
    const badges = new PushBadges(); badges.mark('a', 's1'); badges.mark('a', 's2'); badges.mark('b', 's1');
    const app = createPushRoutes({ badges, owner: (request) => request.headers.get('x-owner') });
    const call = (path: string, owner?: string, body?: unknown) => app.request(`/api/push/${path}`, {
      headers: owner ? { 'x-owner': owner } : {}, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
    expect((await call('badge')).status).toBe(401);
    const read = await call('badge', 'a'); expect(read.headers.get('cache-control')).toBe('no-store');
    expect((await read.json() as { badge: { count: number } }).badge.count).toBe(2);
    expect((await call('badge/reset', 'a', { sessionId: 's1', reason: 'view' })).status).toBe(200);
    expect(badges.snapshot('a').count).toBe(1); expect(badges.snapshot('b').count).toBe(1);
    expect((await call('badge/reset', 'a', { sessionId: 's2', reason: 'auto-accept' })).status).toBe(400);
    expect((await call('visibility', 'a', { visible: true })).status).toBe(200);
    expect(badges.snapshot('a').count).toBe(0); expect(badges.snapshot('b').count).toBe(1);
  });
});
