// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { socketPeer } from '../lib/auth/ui-auth.ts';

describe('socket peer reading', () => {
  it('reads the observed peer from the runtime env and from a request context', async () => {
    expect(socketPeer({ incoming: { socket: { remoteAddress: '127.0.0.1' } } })).toBe('127.0.0.1');
    const seen: (string | undefined)[] = [];
    const app = new Hono();
    app.use('/api/*', async (c, next) => { seen.push(socketPeer(c)); await next(); });
    app.get('/api/sessions', (c) => c.json({ ok: true }));
    await app.request('/api/sessions', {}, { incoming: { socket: { remoteAddress: '::1' } } });
    expect(seen).toEqual(['::1']);
  });
});
