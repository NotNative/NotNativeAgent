// SPDX-License-Identifier: Apache-2.0
/**
 * Client-auth routes (doc 03 section 5.3, semantics in doc 08 sections
 * 2.7/5.4-5.7/3.12-3.13): the device-token management family, pairing
 * sessions (create/list/cancel), the anonymous rate-limited redeem, the
 * section 3.13 candidates refresh, and the transports view. The redeem
 * rides the PUBLIC registrar (registered BEFORE the /api gate) —
 * everything else sits behind the global gate and re-authenticates to
 * learn the caller's authority (manage = UI session | desktop-local |
 * open mode; any client token manages itself only).
 */
import { Hono } from 'hono';
import {
  getUiAuthController, sanitizeOutboundClient,
  type AuthGranted, type AuthOutcome,
} from '../lib/auth/ui-auth.ts';
import type { RemoteClientStore } from '../lib/auth/remote-clients.ts';
import {
  DEFAULT_ALLOWED_CLIENT_KINDS, INVALID_PAIRING_SESSION_ERROR, InvalidPairingSessionError,
  MintFailure, PairingStoreFault, getPairingSessionStore,
} from '../lib/auth/pairing-sessions.ts';
import { createRedeemRateLimiter, rateLimitHeaders, type LoginRateLimiter } from '../lib/auth/rate-limit.ts';
import {
  buildRefreshLanCandidates, buildSessionServerCandidates, dedupeUrlCandidates,
  isLoopbackHostname, lanIpv4FromInterfaces, normalizeDirectUrl, serverLabel,
  serverTransports,
} from '../lib/auth/pairing-candidates.ts';
import {
  normalizeRelayJwk, PRIORITY_RELAY, type PairingCandidate,
} from '../lib/auth/pairing-payload.ts';
import { getRelayHostService, type RelayCandidate } from '../lib/relay/host-service.ts';
import { peekRelayServerId } from '../lib/relay/identity.ts';
import { ENV } from '../env.ts';
import { readJsonBodyBounded } from '../lib/http/read-bounded.ts';

export const CLIENT_BODY_MAX_CHARS = 64 * 1024;
const NO_RATE_KEY = 'no-addr';

type ContextLike = {
  req: { raw: Request; method: string; param: (name: string) => string };
  env: unknown;
};

interface SocketMeta { remoteAddress?: string; localAddress?: string; localPort?: number }

function socketOf(env: unknown): SocketMeta | undefined {
  return (env as { incoming?: { socket?: SocketMeta } } | undefined)?.incoming?.socket ?? undefined;
}

function json(status: number, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extraHeaders },
  });
}

function principalOf(c: ContextLike): AuthOutcome {
  return getUiAuthController().authenticate(c.req.raw.headers, new URL(c.req.raw.url), c.req.method);
}

function granted(outcome: AuthOutcome): AuthGranted | null {
  return outcome.ok ? outcome : null;
}

/** section 2.7 authority: UI session | desktop-local shell token | open
 * mode. A plain client token may only manage ITSELF. */
function manageAuthority(g: AuthGranted): boolean {
  if (g.scope === 'open' || g.scope === 'session') return true;
  return g.scope === 'client' && g.client.clientKind === 'desktop-local';
}

function isSelf(g: AuthGranted, id: string): boolean {
  return g.scope === 'client' && g.clientId === id;
}

function unauthorized(): Response {
  return json(401, { error: 'UI authentication required', locked: true });
}

/** section 3.12 reconcile is fire-and-forget at every pairing/revocation
 * call site; the 60 s poll is the backstop, route sources are instant. */
function fireReconcile(): void {
  void Promise.resolve()
    .then(() => getRelayHostService().reconcile())
    .catch((error: unknown) => {
      console.warn(`client-auth relay reconcile failed: ${String(error)}`);
    });
}

function requestOrigin(raw: Request): string {
  return new URL(raw.url).origin;
}

/** section 3.13 "client-reached address first": the socket's local side
 * (what the device actually hit). Wildcard accepts and loopback hits are
 * not candidates; heartbeat-through-the-relay legs land loopback and are
 * dropped before the interface scan takes over. */
function reachedLanUrl(socket: SocketMeta | undefined): string | null {
  const address = socket?.localAddress;
  const port = socket?.localPort;
  if (typeof address !== 'string' || address === '' || typeof port !== 'number') return null;
  if (address === '::' || address === '0.0.0.0') return null;
  if (isLoopbackHostname(address)) return null;
  const host = address.includes(':') && !address.startsWith('[') ? `[${address}]` : address;
  return `http://${host}:${port}`;
}

/** Service candidates arrive with the canonical truth, but the payload
 * contract is strict (section 5.2): a non-EC or private-member JWK is
 * invalidating, so verify before advertising. */
function canonicalRelayCandidate(candidate: RelayCandidate): PairingCandidate | null {
  const jwk = normalizeRelayJwk(candidate.hostEncPubJwk);
  if (jwk === null) return null;
  return {
    type: 'relay',
    relayUrl: candidate.relayUrl,
    serverId: candidate.serverId,
    hostEncPubJwk: jwk,
    priority: PRIORITY_RELAY,
  };
}

interface SessionCreateBody {
  label: string | null;
  allowedClientKinds: string[] | undefined;
  serverUrl: unknown;
  includeRelay: boolean | undefined;
  includeDirect: boolean | undefined;
}

/** section 5.5 create body: unknown kinds/URLs reject (a link with an
 * unrenderable candidate is worse than a rejected request); an EMPTY
 * label is "unset" (store normalizes to null — the display placeholder
 * posture §5.4), only a non-string label 400s. */
function parseSessionCreateBody(body: Record<string, unknown>): { ok: true; value: SessionCreateBody } | { ok: false; error: string } {
  const label = body['label'];
  if (label !== undefined && label !== null && typeof label !== 'string') {
    return { ok: false, error: 'label must be a string' };
  }
  const kinds = body['allowedClientKinds'];
  if (kinds !== undefined) {
    if (!Array.isArray(kinds)) return { ok: false, error: 'allowedClientKinds must be an array' };
    for (const kind of kinds) {
      if (!(DEFAULT_ALLOWED_CLIENT_KINDS as readonly string[]).includes(kind as string)) {
        return { ok: false, error: 'allowedClientKinds must be "mobile" or "desktop"' };
      }
    }
  }
  const serverUrl = body['serverUrl'];
  if (serverUrl !== undefined && normalizeDirectUrl(serverUrl) === null) {
    return { ok: false, error: 'serverUrl must be an http(s) URL' };
  }
  for (const key of ['includeRelay', 'includeDirect'] as const) {
    const value = body[key];
    if (value !== undefined && typeof value !== 'boolean') return { ok: false, error: `${key} must be a boolean` };
  }
  const trimmedLabel = typeof label === 'string' && label.trim().length > 0 ? label.trim() : null;
  const value: SessionCreateBody = {
    label: trimmedLabel,
    allowedClientKinds: Array.isArray(kinds) ? [...(kinds as string[])] : undefined,
    serverUrl,
    includeRelay: body['includeRelay'] as boolean | undefined,
    includeDirect: body['includeDirect'] as boolean | undefined,
  };
  return { ok: true, value };
}

/** section 5.5/6.1 create flow: candidates first (relay side-before
 * creating the session so usesRelay is true exactly when a relay leg
 * ships), then the one-time session, then 201 {pairing(+secret), server}. */
async function createPairingSessionRoute(c: ContextLike): Promise<Response> {
  const principal = granted(principalOf(c));
  if (principal === null) return unauthorized();
  if (!manageAuthority(principal)) return json(403, { error: 'Client tokens cannot create pairing sessions' });
  const body = await readJsonBodyBounded(c.req.raw, CLIENT_BODY_MAX_CHARS);
  if (body === null) return json(400, { error: 'Invalid request body' });
  const parsed = parseSessionCreateBody(body);
  if (!parsed.ok) return json(400, { error: parsed.error });
  const direct = parsed.value.includeDirect === false
    ? []
    : buildSessionServerCandidates({
      serverUrl: parsed.value.serverUrl,
      requestOrigin: requestOrigin(c.req.raw),
    });
  let relay: PairingCandidate | null = null;
  if (parsed.value.includeRelay === true) {
    try {
      const candidate = await getRelayHostService().ensureEnabledForPairing();
      if (candidate === null || (relay = canonicalRelayCandidate(candidate)) === null) {
        // clear the half-ensure promptly (E-08-33: the poll is the backstop)
        fireReconcile();
        return json(503, { error: 'Relay fallback requested but unavailable' });
      }
    } catch (error) {
      fireReconcile();
      return json(500, { error: `Relay fallback could not be started: ${error instanceof Error ? error.message : String(error)}` });
    }
  } else if (parsed.value.includeRelay === undefined) {
    const candidate = await getRelayHostService().getPairingCandidate();
    relay = candidate === null ? null : canonicalRelayCandidate(candidate);
  }
  const candidates = dedupeUrlCandidates([...direct, ...(relay !== null ? [relay] : [])]);
  if (candidates.length === 0) return json(400, { error: 'No usable pairing candidate' });
  const created = getPairingSessionStore().createPairingSession({
    label: parsed.value.label,
    allowedClientKinds: parsed.value.allowedClientKinds,
    createdByClientId: principal.scope === 'client' ? principal.clientId : null,
    usesRelay: candidates.some((candidate) => candidate.type === 'relay'),
  });
  fireReconcile();
  return json(201, { pairing: created, server: { label: serverLabel(), candidates } });
}

/** section 5.6 redeem (anonymous, rate-limited per raw socket address +
 * pairing id — never req.ip, the proxy must not widen the bucket): ONE
 * generic error text for every failure class (missing, malformed,
 * cancelled, used, expired, wrong kind, wrong secret, 429). */
async function redeemPairingRoute(c: ContextLike, limiter: LoginRateLimiter): Promise<Response> {
  const socket = socketOf(c.env);
  const body = await readJsonBodyBounded(c.req.raw, CLIENT_BODY_MAX_CHARS);
  const pairingId = typeof body?.['pairingId'] === 'string' ? body['pairingId'].trim() : '';
  const secret = typeof body?.['secret'] === 'string' ? body['secret'].trim() : '';
  const key = `${socket?.remoteAddress ?? NO_RATE_KEY}:${pairingId}`;
  const rate = limiter.attempt(key);
  if (!rate.allowed) return json(429, { error: INVALID_PAIRING_SESSION_ERROR }, rateLimitHeaders(rate));
  if (pairingId === '' || secret === '') {
    limiter.record(key);
    return json(400, { error: INVALID_PAIRING_SESSION_ERROR });
  }
  try {
    const outcome = getPairingSessionStore().redeemPairingSession({ ...body, pairingId, secret });
    limiter.clear(key); // a successful redeem clears the entanglement (section 5.5)
    fireReconcile();
    return json(200, {
      ok: true,
      server: {
        label: serverLabel(),
        url: requestOrigin(c.req.raw),
        fingerprint: outcome.pairing.fingerprint,
      },
      client: sanitizeOutboundClient(outcome.client),
      clientToken: outcome.token, // plaintext, exactly once (section 5.4)
    });
  } catch (error) {
    // §5.4 scoping: the generic text + rate bucket belong to AUTH classes
    // only. A server fault (mint wiring, store write) answers 5xx, keeps
    // the bucket, and never feeds the attacker an oracle (review P1).
    if (error instanceof MintFailure || error instanceof PairingStoreFault) {
      return json(500, { error: 'Pairing redeem failed' });
    }
    limiter.record(key);
    if (error instanceof InvalidPairingSessionError) return json(400, { error: INVALID_PAIRING_SESSION_ERROR });
    return json(500, { error: 'Pairing redeem failed' });
  }
}

/** section 3.13 refresh: the client-reached address first, then the
 * interface scan, relay last — serverId rides when the identity exists
 * (clients gate every refresh and learned address on it). */
async function candidatesRoute(c: ContextLike, port: number): Promise<Response> {
  if (granted(principalOf(c)) === null) return unauthorized();
  const reached = reachedLanUrl(socketOf(c.env));
  const scanned = lanIpv4FromInterfaces();
  const scanUrl = scanned === null ? null : `http://${scanned}:${port}`;
  const candidates = buildRefreshLanCandidates({ reachedUrl: reached, scannedLan: scanUrl });
  const relay = await getRelayHostService().getPairingCandidate();
  const relayCandidate = relay === null ? null : canonicalRelayCandidate(relay);
  if (relayCandidate !== null) candidates.push(relayCandidate);
  const serverId = await peekRelayServerId();
  return json(200, {
    label: serverLabel(),
    ...(serverId ? { serverId } : {}),
    candidates,
  });
}

/** Public surface: ONLY the redeem (section 5.5: anonymous + rate-limited).
 * Registered BEFORE the /api gate — the redeem cannot ride a session. */
export function createClientAuthPublicRoutes(options: { redeemRateLimiter?: LoginRateLimiter } = {}): Hono {
  const publicApp = new Hono();
  const limiter = options.redeemRateLimiter ?? createRedeemRateLimiter();
  publicApp.post('/api/client-auth/pairing/redeem', (c) => redeemPairingRoute(c, limiter));
  return publicApp;
}

/** Gated family (registered between the gate and the harness proxy). */
export function registerClientAuthRoutes(
  app: Hono,
  options: { port?: number; host?: string } = {},
): void {
  const port = options.port ?? ENV.port;
  const host = options.host ?? ENV.host;
  registerClientDeviceRoutes(app);
  registerCandidateRoutes(app, port, host);
}

/** §2.7 authority rows: manage sees all; a client token only itself; any
 * client token may revoke ITSELF; only manage creates/purges. */
function registerClientDeviceRoutes(app: Hono): void {
  // Remote devices (section 2.7): manage sees all; a client token only itself.
  app.get('/api/client-auth/clients', (c) => {
    const principal = granted(principalOf(c));
    if (principal === null) return unauthorized();
    const store = clients();
    if (manageAuthority(principal)) return json(200, { clients: store.listClients().map(sanitizeOutboundClient) });
    const own = principal.scope === 'client' ? store.listClients().filter((r) => r.id === principal.clientId) : [];
    return json(200, { clients: own.map(sanitizeOutboundClient) });
  });

  app.post('/api/client-auth/clients', async (c) => {
    const principal = granted(principalOf(c));
    if (principal === null) return unauthorized();
    if (!manageAuthority(principal)) return json(403, { error: 'Client tokens cannot create remote clients' });
    const body = await readJsonBodyBounded(c.req.raw, CLIENT_BODY_MAX_CHARS);
    if (body === null) return json(400, { error: 'Invalid request body' });
    const created = clients().createClient(clientCreateInput(body));
    return json(201, { client: sanitizeOutboundClient(created.client), token: created.token });
  });

  app.delete('/api/client-auth/clients/:id', (c) => {
    const principal = granted(principalOf(c));
    if (principal === null) return unauthorized();
    const id = c.req.param('id');
    const store = clients();
    const record = store.listClients().find((entry) => entry.id === id);
    if (record === undefined) return json(404, { revoked: false, error: 'Client not found' });
    if (!isSelf(principal, id) && !manageAuthority(principal)) {
      return json(403, { revoked: false, error: 'Client tokens can only revoke themselves' });
    }
    store.revokeClient(id);
    fireReconcile(); // section 3.12: revocation may drop the last relay demand
    return json(200, { revoked: true, client: sanitizeOutboundClient(record) });
  });

  app.delete('/api/client-auth/clients', (c) => {
    const principal = granted(principalOf(c));
    if (principal === null) return unauthorized();
    if (!manageAuthority(principal)) return json(403, { revoked: false, error: 'Client tokens can only revoke themselves' });
    const purged = clients().purgeRevokedClients();
    fireReconcile();
    return json(200, { purged });
  });
}

/** Pairing surface + §3.13 refresh/transports: session/desktop-local (or
 * open mode) authority — a hijacked device token must not poll pairing
 * state or learn the LAN topology (review P1; candidates refresh stays
 * bearer-wide per §3.13, riding relay/direct transports). */
function registerCandidateRoutes(app: Hono, port: number, host: string): void {
  app.get('/api/client-auth/connection/candidates', (c) => candidatesRoute(c, port));

  app.get('/api/client-auth/pairing/transports', async (c) => {
    const principal = granted(principalOf(c));
    if (principal === null) return unauthorized();
    if (!manageAuthority(principal)) return json(403, { error: 'Client tokens cannot read the pairing surface' });
    const view = serverTransports({ host, port });
    const relayCandidate = await getRelayHostService().getPairingCandidate();
    return json(200, { ...view, relayAvailable: relayCandidate !== null });
  });

  app.get('/api/client-auth/pairing/sessions', (c) => {
    const principal = granted(principalOf(c));
    if (principal === null) return unauthorized();
    if (!manageAuthority(principal)) return json(403, { error: 'Client tokens cannot read the pairing surface' });
    return json(200, { pending: getPairingSessionStore().listPendingSessions() });
  });

  app.post('/api/client-auth/pairing/sessions', (c) => createPairingSessionRoute(c));

  app.delete('/api/client-auth/pairing/sessions/:id', (c) => {
    const principal = granted(principalOf(c));
    if (principal === null) return unauthorized();
    if (!manageAuthority(principal)) return json(403, { error: 'Client tokens cannot cancel pairing sessions' });
    const outcome = getPairingSessionStore().cancelPairingSession(c.req.param('id'));
    if (!outcome.cancelled) return json(404, { cancelled: false, error: 'Pairing session not found' });
    fireReconcile(); // a cancelled relay session may be the last demand
    return json(200, { cancelled: true, pairing: outcome.pairing });
  });
}

function clients(): RemoteClientStore {
  return getUiAuthController().getClientStore();
}

function clientCreateInput(body: Record<string, unknown>): { label?: string; clientKind?: string; dedupeKey?: string } {
  const nonEmpty = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  const input: { label?: string; clientKind?: string; dedupeKey?: string } = {};
  const label = nonEmpty(body['label']);
  if (label !== undefined) input.label = label;
  const clientKind = nonEmpty(body['clientKind']);
  if (clientKind !== undefined) input.clientKind = clientKind;
  const dedupeKey = nonEmpty(body['dedupeKey']);
  if (dedupeKey !== undefined) input.dedupeKey = dedupeKey;
  return input;
}
