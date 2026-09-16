// SPDX-License-Identifier: Apache-2.0
/**
 * /auth/* — session status + URL-token minting (doc 01 HP-10).
 * Full auth model (scrypt passwords, JWT, passkeys, device tokens) is doc 08,
 * phase P11. P0 ships an allow-all session and an optional simple password.
 */
import { Hono } from 'hono';
import { ENV } from '../env.ts';

type UrlToken = { token: string; expiresAt: number };
const urlTokens = new Map<string, UrlToken>();

export function isValidUrlToken(token: string | null | undefined): boolean {
  if (!token) return false;
  const entry = urlTokens.get(token);
  if (!entry) return false;
  if (entry.expiresAt < Date.now()) return false;
  return true;
}

export function createAuthRoutes(): Hono {
  const app = new Hono();

  app.get('/auth/session', (c) =>
    c.json({
      authenticated: ENV.uiPassword === '',
      authRequired: ENV.uiPassword !== '',
      methods: ['password'],
      passkeys: false,
    }),
  );

  app.post('/auth/login', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { password?: string };
    if (ENV.uiPassword === '' || body?.password === ENV.uiPassword) {
      return c.json({ success: true, trustDeviceOffer: true });
    }
    return c.json({ success: false, error: 'invalid password' }, 401);
  });

  app.post('/auth/logout', (c) => c.json({ success: true }));

  app.post('/auth/url-token', (c) => {
    const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
    const expiresAt = Date.now() + 600_000;
    urlTokens.set(token, { token, expiresAt });
    // opportunistic sweep
    for (const [key, entry] of urlTokens) {
      if (entry.expiresAt < Date.now()) urlTokens.delete(key);
    }
    return c.json({ token, expiresAt: new Date(expiresAt).toISOString() });
  });

  return app;
}
