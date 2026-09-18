// SPDX-License-Identifier: Apache-2.0
/**
 * /auth + reset surface (doc 08 sections 2.2/2.3/2.6): session status,
 * password login (cookies, trust-device, desktop client-token mint),
 * URL-token minting and global sign-out reset. The tunnel-scope locks ride
 * in with the scope classifier (§2.9, P8-1 step 4).
 */
import { Hono } from 'hono';
import { CLEAR_SESSION_COOKIE_HEADER, getUiAuthController, parseClientIp, type RouteAction } from '../lib/auth/ui-auth.ts';

interface SocketEnv {
  incoming?: { socket?: { remoteAddress?: string } };
}

function remoteSocketAddress(env: unknown): string | undefined {
  const address = (env as SocketEnv | undefined ?? undefined)?.incoming?.socket?.remoteAddress;
  return typeof address === 'string' ? address : undefined;
}

export function createAuthRoutes(): Hono {
  const app = new Hono();

  app.get('/auth/session', (c) =>
    finalize(getUiAuthController().sessionStatus(c.req.raw.headers, new URL(c.req.raw.url), c.req.method)));

  app.post('/auth/session', async (c) => {
    const ip = parseClientIp(c.req.raw.headers, remoteSocketAddress(c.env));
    const action = getUiAuthController().login({
      ip,
      body: await readLoginDocumentBody(c.req.raw),
      headers: c.req.raw.headers,
      url: new URL(c.req.raw.url),
      method: c.req.method,
    });
    return finalize(action);
  });

  app.post('/auth/url-token', (c) =>
    finalize(getUiAuthController().mintUrlTokenFromRequest(c.req.raw.headers, new URL(c.req.raw.url), c.req.method)));

  app.post('/api/auth/reset', (c) =>
    finalize(getUiAuthController().resetSessionAuth(c.req.raw.headers)));

  return app;
}

/** 64 KiB: the login document is {password,flags...}; anything larger is
 * garbage (or a memory-DoS attempt on the only unauthenticated body read). */
const LOGIN_BODY_MAX_BYTES = 64 * 1024;

async function readLoginDocumentBody(raw: Request): Promise<unknown> {
  try {
    const text = await readTextBounded(raw, LOGIN_BODY_MAX_BYTES);
    if (text === null) return undefined; // oversize -> same 401 flow, recorded as the failed attempt
    if (text === '') return null;
    return JSON.parse(text) as unknown;
  } catch {
    return null; // malformed body -> null -> verifyPassword fails -> 401 flow
  }
}

async function readTextBounded(raw: Request, max: number): Promise<string | null> {
  const reader = raw.body?.getReader();
  if (reader === undefined) return '';
  let text = '';
  const decoder = new TextDecoder();
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) return null;
    text += decoder.decode(value, { stream: true });
  }
  return `${text}${decoder.decode()}`;
}

function finalize(action: RouteAction): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(action.headers ?? {})) headers.set(name, value);
  if (action.setCookie !== undefined) headers.append('set-cookie', action.setCookie);
  if (action.clearSessionCookie === true) headers.append('set-cookie', CLEAR_SESSION_COOKIE_HEADER);
  return new Response(JSON.stringify(action.body), { status: action.status, headers });
}
