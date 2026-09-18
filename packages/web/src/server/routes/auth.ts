// SPDX-License-Identifier: Apache-2.0
/**
 * /auth + reset + connect surface (doc 08 sections 2.2/2.3/2.6/2.9/4.5):
 * session status, password login (cookies, trust-device, desktop
 * client-token mint), URL-token minting, global sign-out reset, and the
 * one-time /connect?t= tunnel entrance. The §2.9 scope classifier hardens
 * /auth at tunnel|unknown-public scope: password login, reset and passkey
 * flows are 403, /auth/session answers the tunnel row, and credential
 * requests ride through normally for device bearers.
 */
import { Hono } from 'hono';
import {
  CLEAR_SESSION_COOKIE_HEADER, getUiAuthController, parseClientIp, secureFromHeaders, type RouteAction,
} from '../lib/auth/ui-auth.ts';
import {
  getTunnelAuthController, type RequestScope, type TunnelSession,
} from '../lib/auth/tunnel-auth.ts';

interface SocketEnv {
  incoming?: { socket?: { remoteAddress?: string } };
}

function remoteSocketAddress(env: unknown): string | undefined {
  const socket = (env as SocketEnv | undefined ?? undefined)?.incoming?.socket;
  const address = socket?.remoteAddress;
  return typeof address === 'string' ? address : undefined;
}

function requestScope(headers: Headers, url: URL, socketAddress?: string): RequestScope {
  return getTunnelAuthController().classify(headers, url, socketAddress);
}

export function createAuthRoutes(): Hono {
  const app = new Hono();

  app.get('/auth/session', (c) => {
    const headers = c.req.raw.headers;
    const url = new URL(c.req.raw.url);
    const scope = requestScope(headers, url, remoteSocketAddress(c.env));
    if (scope === 'tunnel' || scope === 'unknown-public') return finalize(tunnelSessionStatus(headers, url, c.req.method));
    return finalize(getUiAuthController().sessionStatus(headers, url, c.req.method));
  });

  app.post('/auth/session', async (c) => {
    const headers = c.req.raw.headers;
    const url = new URL(c.req.raw.url);
    if (requestScope(headers, url, remoteSocketAddress(c.env)) !== 'local') {
      return finalize({ status: 403, body: { error: 'Password login is disabled for tunnel scope', tunnelLocked: true }, headers: { 'cache-control': 'no-store' } });
    }
    const ip = parseClientIp(headers, remoteSocketAddress(c.env));
    const action = getUiAuthController().login({
      ip,
      body: await readDocumentBody(c.req.raw),
      headers,
      url,
      method: c.req.method,
    });
    return finalize(action);
  });

  app.post('/auth/url-token', (c) => {
    const headers = c.req.raw.headers;
    const url = new URL(c.req.raw.url);
    const scope = requestScope(headers, url, remoteSocketAddress(c.env));
    // Mint = session cookie or client bearer (§2.6). At tunnel scope the ui
    // session cookie does not authenticate: only a device bearer rides the
    // tunnel; anonymous visitors and tunnel sessions cannot mint.
    if (scope !== 'local' && !getUiAuthController().credentialGrant(headers, url, c.req.method, false)) {
      return finalize({ status: 401, body: { error: 'UI authentication required', locked: true }, headers: { 'cache-control': 'no-store' } });
    }
    return finalize(getUiAuthController().mintUrlTokenFromRequest(headers, url, c.req.method));
  });

  app.post('/api/auth/reset', (c) => {
    const headers = c.req.raw.headers;
    if (requestScope(headers, new URL(c.req.raw.url), remoteSocketAddress(c.env)) !== 'local') {
      return finalize({ status: 403, body: { error: 'Global auth reset is disabled for tunnel scope', tunnelLocked: true }, headers: { 'cache-control': 'no-store' } });
    }
    return finalize(getUiAuthController().resetSessionAuth(headers));
  });

  // One-time tunnel entrance (§4.5): rate-limited, newest-token exchange,
  // 302 -> / with the oc_tunnel_session cookie. Never cached.
  app.get('/connect', (c) => handleConnect(c.req.raw.headers, new URL(c.req.raw.url), remoteSocketAddress(c.env)));

  return app;
}

/** /connect handling (§4.5): rate limit first, then the newest-token
 * exchange; redeem failures record and answer 401 plain text, rate locks
 * answer 429 + Retry-After, and success 302s to / with the Lax cookie.
 * Failures clear no cookies (E-08-17). */
function handleConnect(headers: Headers, url: URL, socketAddress?: string): Response {
  const tunnel = getTunnelAuthController();
  const rate = tunnel.attemptConnect(headers, socketAddress);
  if (!rate.allowed) return new Response('Too many connect attempts', { status: 429, headers: rate.headers });
  const grant = tunnel.redeemToken(url.searchParams.get('t'));
  if (!grant.ok) {
    tunnel.recordConnectFailure(headers, socketAddress);
    return new Response(grant.body, {
      status: grant.status,
      headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  const out = new Headers({ location: grant.redirectTo, 'cache-control': 'no-store' });
  out.append('set-cookie', grant.cookieValue + (secureFromHeaders(headers, url) ? '; Secure' : ''));
  return new Response(null, { status: 302, headers: out });
}

/** §2.9 GET /auth/session at tunnel scope: valid tunnel session ->
 * {authenticated:true, scope:'tunnel'}; device bearer/URL-token
 * credentials still answer (E-08-18); everything else is
 * {authenticated:false, locked:true, tunnelLocked:true} with the ui
 * cookie cleared. */
function tunnelSessionStatus(headers: Headers, url: URL, method: string): RouteAction {
  const ui = getUiAuthController();
  if (ui.credentialGrant(headers, url, method)) {
    return {
      status: 200,
      body: { authenticated: true, scope: 'client', authRequired: ui.passwordRequired(), methods: ['password'], passkeys: false },
      headers: { 'cache-control': 'no-store' },
    };
  }
  const session: TunnelSession | null = getTunnelAuthController().sessionFromCookie(headers.get('cookie') ?? undefined);
  if (session !== null) {
    return {
      status: 200,
      body: { authenticated: true, scope: 'tunnel', authRequired: false, methods: ['tunnel'], passkeys: false },
      headers: { 'cache-control': 'no-store' },
    };
  }
  return {
    status: 401,
    body: { authenticated: false, locked: true, tunnelLocked: true },
    clearSessionCookie: typeof headers.get('cookie') === 'string' && (headers.get('cookie') as string).length > 0,
    headers: { 'cache-control': 'no-store' },
  };
}

async function readDocumentBody(raw: Request): Promise<unknown> {
  const text = await readTextBounded(raw, 64 * 1024);
  if (text === null) return null; // oversize -> failed attempt -> 401 flow
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null; // malformed body -> null -> verifyPassword fails -> 401 flow
  }
}

/** 64 KiB bounded read: the only unauthenticated body surface must never
 * buffer arbitrary LAN noise into memory. */
async function readTextBounded(raw: Request, max: number): Promise<string | null> {
  const stream = raw.body?.getReader();
  if (stream === undefined) return '';
  const decoder = new TextDecoder();
  let total = '';
  let budget = max;
  while (budget >= 0) {
    const next = await stream.read();
    if (next.done) return total + decoder.decode();
    const chunk = decoder.decode(next.value, { stream: true });
    total += chunk;
    budget -= chunk.length;
    if (budget < 0) {
      await stream.cancel().catch(() => undefined);
      return null;
    }
  }
  return null;
}

function finalize(action: RouteAction): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(action.headers ?? {})) headers.set(name, value);
  if (action.setCookie !== undefined) headers.append('set-cookie', action.setCookie);
  if (action.clearSessionCookie === true) headers.append('set-cookie', CLEAR_SESSION_COOKIE_HEADER);
  return new Response(JSON.stringify(action.body), { status: action.status, headers });
}
