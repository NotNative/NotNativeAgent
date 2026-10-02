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
  UI_SESSION_COOKIE,
} from '../lib/auth/ui-auth.ts';
import {
  getTunnelAuthController, type RequestScope, type TunnelSession,
} from '../lib/auth/tunnel-auth.ts';
import { getUiPasskeysController, type PasskeyAction } from '../lib/auth/ui-passkeys.ts';
import { readTextBounded } from '../lib/http/read-bounded.ts';

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

const uiAuthProvider = (): ReturnType<typeof getUiAuthController> => getUiAuthController();

/** §2.4 tunnel-scope lock: every passkey endpoint hard-403s. */
async function guardedPasskeyScope<T extends PasskeyAction>(
  c: { req: { raw: Request }; env: unknown },
  handler: (pk: ReturnType<typeof getUiPasskeysController>, headers: Headers, url: URL) => Promise<T> | T,
): Promise<T | PasskeyAction> {
  const headers = c.req.raw.headers;
  const url = new URL(c.req.raw.url);
  if (requestScope(headers, url, remoteSocketAddress(c.env)) !== 'local') {
    return { status: 403, body: { error: 'Passkey endpoints are disabled for tunnel scope', tunnelLocked: true }, headers: { 'cache-control': 'no-store' } };
  }
  return handler(getUiPasskeysController(uiAuthProvider), headers, url);
}

/** Registration gates: disabled-400 first, then the session-cookie-only
 * rule (§2.2/§2.4: a bare client token never registers keys). */
async function guardedPasskey<T extends PasskeyAction>(
  c: { req: { raw: Request }; env: unknown },
  handler: (pk: ReturnType<typeof getUiPasskeysController>, headers: Headers, url: URL) => Promise<T> | T,
): Promise<T | PasskeyAction> {
  return guardedPasskeyScope(c, async (pk, headers, url) => {
    if (!pk.hasPassword()) return pk.disabledAction();
    if (!getUiAuthController().requireSessionCookie(headers)) {
      return { status: 401, body: { error: 'UI authentication required', locked: true }, headers: { 'cache-control': 'no-store' } };
    }
    return handler(pk, headers, url);
  });
}

/** Management gates: also cookie-only (the /api global gate already passed;
 * a bearer that got through must still be refused here, §2.4). */
async function managementPasskey<T extends PasskeyAction>(
  c: { req: { raw: Request; param?: (name: string) => string }; env: unknown },
  handler: (pk: ReturnType<typeof getUiPasskeysController>, headers: Headers, url: URL) => T,
): Promise<PasskeyAction> {
  const headers = c.req.raw.headers;
  const url = new URL(c.req.raw.url);
  if (requestScope(headers, url, remoteSocketAddress(c.env)) !== 'local') {
    return { status: 403, body: { error: 'Passkey endpoints are disabled for tunnel scope', tunnelLocked: true }, headers: { 'cache-control': 'no-store' } };
  }
  const pk = getUiPasskeysController(uiAuthProvider);
  if (!pk.hasPassword()) return pk.disabledAction();
  if (!getUiAuthController().requireSessionCookie(headers)) {
    return { status: 401, body: { error: 'UI authentication required', locked: true }, headers: { 'cache-control': 'no-store' } };
  }
  return handler(pk, headers, url);
}

function passkeyAction(action: PasskeyAction | RouteAction): Response {
  return finalize(action as RouteAction);
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

  registerSessionRoutes(app);
  app.post('/auth/native-bootstrap', async (c) => {
    const raw = c.req.raw;
    if (requestScope(raw.headers, new URL(raw.url), remoteSocketAddress(c.env)) !== 'local'
      || !/^application\/json(?:\s*;|$)/iu.test(raw.headers.get('content-type') ?? '')) {
      return finalize({ status: 403, body: { authenticated: false, locked: true }, headers: { 'cache-control': 'no-store' } });
    }
    const text = await readTextBounded(raw, 1024);
    let body: unknown = null;
    try { body = text === null ? null : JSON.parse(text); } catch { /* Malformed tickets fail closed. */ }
    return finalize(getUiAuthController().nativeBootstrap(body, raw.headers, new URL(raw.url), remoteSocketAddress(c.env)));
  });
  registerPasskeyRoutes(app);

  // One-time tunnel entrance (§4.5): rate-limited, newest-token exchange,
  // 302 -> / with the oc_tunnel_session cookie. Never cached.
  app.get('/connect', (c) => handleConnect(c.req.raw.headers, new URL(c.req.raw.url), remoteSocketAddress(c.env)));

  return app;
}

/** Password login, URL-token minting, and the global sign-out reset
 * (§2.3/§2.6/§2.2): tunnel scope hard-403s login/reset, and the reset tail
 * purges passkeys (E-08-3 completion). */
function registerSessionRoutes(app: Hono): void {
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
    const action = getUiAuthController().resetSessionAuth(headers);
    if (action.status === 200) getUiPasskeysController(uiAuthProvider).resetForAuthReset(); // E-08-3 tail
    return finalize(action);
  });
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

function finalize(action: RouteAction | PasskeyAction): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(action.headers ?? {})) headers.set(name, value);
  if (action.setCookie !== undefined) headers.append('set-cookie', action.setCookie);
  if (action.clearSessionCookie === true) headers.append('set-cookie', CLEAR_SESSION_COOKIE_HEADER);
  return new Response(JSON.stringify(action.body), { status: action.status, headers });
}

/** Passkey surface (§2.4): registration/management are session-cookie-only
 * (registration gates + the gated /api management rows), authentication is
 * anonymous over the login rate limit, and the whole family is hard-403 at
 * tunnel scope. Routes finalize through the SHARED builder so a granted
 * login's Set-Cookie attaches to the authenticate/verify answer. */
function registerPasskeyRoutes(app: Hono): void {
  app.post('/auth/passkey/register/options', async (c) =>
    passkeyAction(await guardedPasskey(c, (pk, headers, url) => pk.registerOptions(headers, url))));

  app.post('/auth/passkey/register/verify', async (c) =>
    passkeyAction(await guardedPasskey(c, async (pk, headers, url) =>
      pk.registerVerify(headers, url, await readDocumentBody(c.req.raw)))));

  app.post('/auth/passkey/authenticate/options', async (c) =>
    passkeyAction(await guardedPasskeyScope(c, (pk, headers, url) => pk.authenticationOptions(headers, url))));

  app.post('/auth/passkey/authenticate/verify', async (c) => {
    const headers = c.req.raw.headers;
    const ip = parseClientIp(headers, remoteSocketAddress(c.env));
    return passkeyAction(await guardedPasskeyScope(c, async (pk, headers2, url) =>
      pk.authenticateVerify(headers2, url, await readDocumentBody(c.req.raw), ip)));
  });

  app.get('/api/passkeys', async (c) =>
    passkeyAction(await managementPasskey(c, (pk, headers, url) => pk.listFor(headers, url))));

  app.delete('/api/passkeys/:id', async (c) =>
    passkeyAction(await managementPasskey(c, (pk, headers, url) => pk.revoke(c.req.param('id'), headers, url))));
}
