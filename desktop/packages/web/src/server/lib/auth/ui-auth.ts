// SPDX-License-Identifier: Apache-2.0
/**
 * UI auth controller (doc 08 sections 2.2/2.3/2.6): scrypt password
 * verification, hand-rolled HS256 session cookie (`oc_ui_session`), the
 * login flow with per-IP rate limiting, short-lived URL tokens for
 * cookie-less WS/SSE/asset paths (allowlist in url-tokens.ts), and the
 * global /api gate. The coordinated `nn_url_token` alias rides next to the
 * doc literal until the coordination pass.
 */
import { NativeUiBootstrap, type NativeUiIdentity } from './native-ui-auth.ts';
import { parseCookieHeader, secureFromHeaders, sessionCookieHeaderValue, sanitizeOutboundClient } from './ui-auth-format.ts';
export { parseClientIp, parseCookieHeader, secureFromHeaders, sessionCookieHeaderValue, sanitizeOutboundClient } from './ui-auth-format.ts';
import { randomBytes } from 'node:crypto';
import { ENV } from '../../env.ts';
import { readEnvUiPassword } from '../../env.ts';
import { createPasswordHashCache, normalizedPassword, passwordMatches, type PasswordSecrets } from './password.ts';
import { getTunnelAuthController } from './tunnel-auth.ts';
import {
  resolveJwtSecretHolder, signSessionJwt, verifySessionJwt,
  type JwtSecretHolder,
} from './jwt.ts';
import { firstQueryParam, urlTokenTargetAllowed } from './url-tokens.ts';
import {
  createLoginRateLimiter, DEFAULT_RATE_LIMIT_CONFIG, envRateLimitOverrides,
  rateLimitHeaders, type LoginRateLimitConfig, type LoginRateLimiter,
} from './rate-limit.ts';
import { RemoteClientStore, type RemoteClientRecord } from './remote-clients.ts';

export const UI_SESSION_COOKIE = 'oc_ui_session';
export const CLEAR_SESSION_COOKIE_HEADER = `${UI_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;

const CLIENT_URL_PARENT_PREFIX = 'client:'; // URL tokens bound to device records (doc 08 section 2.6)
const NO_STORE = 'no-store';

export type AuthGranted =
  | { ok: true; scope: 'open' }
  | { ok: true; scope: 'session'; sessionToken: string }
  | { ok: true; scope: 'client'; sessionToken: string; clientId: string; client: RemoteClientRecord };

export interface AuthDenied {
  ok: false;
  status: number;
  body: Record<string, unknown>;
  clearSessionCookie: boolean;
  headers: Record<string, string>;
}

export type AuthOutcome = AuthGranted | AuthDenied;

export interface RouteAction {
  status: number;
  body: Record<string, unknown>;
  setCookie?: string;
  clearSessionCookie?: boolean;
  headers: Record<string, string>;
}

export interface LoginInputs {
  ip: string;
  body: unknown;
  headers: Headers;
  url: URL;
  method: string;
}

export interface UiAuthOptionsInput {
  nativeAuth?: NativeUiIdentity;
  dataDir?: string;
  clientStore?: RemoteClientStore;
  now?: () => number;
  sessionTtlMs?: number;
  trustSessionTtlMs?: number;
  urlTokenTtlMs?: number;
  urlTokenBudget?: number;
  resolvePassword?: () => string;
  rate?: Partial<LoginRateLimitConfig>;
}

interface ResolvedOptions {
  dataDir: string;
  clientStore: RemoteClientStore;
  now: () => number;
  sessionTtlMs: number;
  trustSessionTtlMs: number;
  urlTokenTtlMs: number;
  urlTokenBudget: number;
  resolvePassword: () => string;
  rate: LoginRateLimitConfig;
}

export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60_000;
export const DEFAULT_TRUST_SESSION_TTL_MS = 7 * 24 * 60 * 60_000;
export const DEFAULT_URL_TOKEN_TTL_MS = 60_000;
const DEFAULT_URL_TOKEN_BUDGET = 512;

/** Only a desktop shell may mint its durable device token at login (§2.3 5). */
const DESKTOP_MINT_KINDS = new Set(['desktop', 'desktop-local']);

interface UrlTokenEntry { parent: string; expiresAt: number }

export class UiAuthController {
  private readonly native: NativeUiBootstrap | null;
  private readonly jwt: JwtSecretHolder;
  private readonly bindingJwt: JwtSecretHolder;
  private readonly limiter: LoginRateLimiter;
  private readonly hashCache: (password: string) => PasswordSecrets;
  private readonly urlTokens = new Map<string, UrlTokenEntry>();
  private readonly options: ResolvedOptions;

  constructor(options: UiAuthOptionsInput = {}) {
    // Boot default rides ENV.dataDir (hoedirs fallback; review P0): a bare
    // `new UiAuthController()` on a stock launch must land in the real dir.
    const dataDir = options.dataDir ?? process.env.NOTNATIVE_DATA_DIR ?? ENV.dataDir;
    this.options = {
      dataDir,
      clientStore: options.clientStore ?? new RemoteClientStore(dataDir),
      now: options.now ?? Date.now,
      sessionTtlMs: options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
      trustSessionTtlMs: options.trustSessionTtlMs ?? DEFAULT_TRUST_SESSION_TTL_MS,
      urlTokenTtlMs: options.urlTokenTtlMs ?? DEFAULT_URL_TOKEN_TTL_MS,
      urlTokenBudget: options.urlTokenBudget ?? DEFAULT_URL_TOKEN_BUDGET,
      resolvePassword: options.resolvePassword ?? defaultResolvePassword,
      rate: { ...DEFAULT_RATE_LIMIT_CONFIG, ...envRateLimitOverrides(), ...options.rate },
    };
    this.limiter = createLoginRateLimiter(this.options.rate, this.options.now);
    this.hashCache = createPasswordHashCache();
    this.native = options.nativeAuth ? new NativeUiBootstrap(options.nativeAuth, this.options.now) : null;
    this.jwt = this.native?.jwt ?? resolveJwtSecretHolder(this.options.dataDir);
    this.bindingJwt = this.native ? resolveJwtSecretHolder(this.options.dataDir) : this.jwt;
  }

  passwordRequired(): boolean {
    return normalizedPassword(this.options.resolvePassword()) !== '';
  }

  authRequired(): boolean { return this.native !== null || this.passwordRequired(); }
  nativeMode(): boolean { return this.native !== null; }
  nativeRequestAllowed(headers: Headers, url: URL): boolean { return this.native?.allowed(headers, url) ?? true; }
  nativeHandle(): { issueTicket(): { ticket: string; expiresAt: string }; revoke(): void } | undefined {
    return this.native ? { issueTicket: () => this.native!.issueTicket(), revoke: () => this.native!.close() } : undefined;
  }
  close(): void { this.native?.close(); this.urlTokens.clear(); }
  nativeBootstrap(body: unknown, headers: Headers, url: URL, peer?: string): RouteAction {
    if (!this.native?.consume(body, headers, url, peer)) return this.deniedAction();
    return this.grantedLogin({ ip: peer ?? '', body: {}, headers, url });
  }
  private methods(): string[] { return [...(this.native ? ['native-bootstrap'] : []), ...(this.passwordRequired() ? ['password'] : [])]; }
  private deniedAction(): RouteAction {
    return { status: 401, body: { authenticated: false, locked: true, authRequired: this.authRequired(), methods: this.methods() }, headers: { 'cache-control': NO_STORE } };
  }

  /** Seam for the passkeys store's HMAC binding (§2.4): the resolved
   * password and the session JWT secret, read-only. */
  resolvePasswordForBinding(): string {
    return this.options.resolvePassword();
  }

  jwtSecretForBinding(): string {
    return this.bindingJwt.secret();
  }

  /** Cookie-session check for requireSessionAuth surfaces (§2.2: passkeys
   * registration/management + global reset accept the cookie ONLY). */
  requireSessionCookie(headers: Headers): boolean {
    const validity = { clearSessionCookie: false };
    return this.byCookie(headers, validity) !== null;
  }

  /** Relay demand signal (§3.12, remote devices): delegates to the owned
   * credential store so the relay service never builds a parallel store. */
  hasActiveRelayClients(): boolean {
    return this.options.clientStore.hasActiveRelayClients();
  }

  /** Read seam for the pairing store's default mint and the client-auth
   * routes (§2.7 authority rows run against the same shared store). */
  getClientStore(): RemoteClientStore {
    return this.options.clientStore;
  }

  verifyPassword(candidate: unknown): boolean {
    const resolved = normalizedPassword(this.options.resolvePassword());
    if (resolved === '') return false; // open mode never verifies
    const normalized = normalizedPassword(candidate);
    if (normalized === '') return false;
    return passwordMatches(normalized, this.hashCache(resolved));
  }

  issueSessionToken(ttlMs: number): { token: string; expiresAt: string } {
    if (this.native?.closed) throw new Error('Native UI authentication is closed');
    const stamp = this.options.now();
    const token = signSessionJwt(this.jwt.secret(), stamp, stamp + ttlMs);
    return { token, expiresAt: new Date(stamp + ttlMs).toISOString() };
  }

  authenticate(headers: Headers, url: URL, method: string, urlTokensEnabled: boolean = true): AuthOutcome {
    if (!this.nativeRequestAllowed(headers, url)) return { ...this.deniedAction(), ok: false, clearSessionCookie: false };
    const bearer = headers.get('authorization');
    if (bearer !== null) return this.byBearer(bearer); // explicit bearer: cookie deliberately ignored (§2.2)
    const validity: { clearSessionCookie: boolean } = { clearSessionCookie: false };
    const fromCookie = this.byCookie(headers, validity);
    if (fromCookie !== null) return fromCookie;
    const fromUrlToken = urlTokensEnabled ? this.byUrlToken(headers, url, method) : null;
    if (fromUrlToken !== null) return fromUrlToken;
    if (!this.authRequired()) return { ok: true, scope: 'open' };
    return {
      ok: false,
      status: 401,
      body: { error: 'UI authentication required', locked: true },
      clearSessionCookie: validity.clearSessionCookie,
      headers: { 'cache-control': NO_STORE },
    };
  }

  private byCookie(headers: Headers, validity: { clearSessionCookie: boolean }): AuthGranted | null {
    const jar = parseCookieHeader(headers.get('cookie'));
    const raw = jar.get(UI_SESSION_COOKIE);
    if (raw === undefined || raw === '') return null;
    if (verifySessionJwt(this.jwt.secret(), raw, this.options.now())) {
      return { ok: true, scope: 'session', sessionToken: raw };
    }
    validity.clearSessionCookie = true;
    return null;
  }

  private byUrlToken(headers: Headers, url: URL, method: string): AuthGranted | null {
    const token = firstQueryParam(url);
    if (token !== null) {
      const upgrade = (headers.get('upgrade') ?? '') !== '';
      const parent = urlTokenTargetAllowed(method, url.pathname, upgrade) ? this.resolveUrlToken(token) : null;
      if (parent !== null) return this.byParentToken(parent);
    }
    return null; // rejected URL tokens fall through to cookie/open (§2.6)
  }

  private byParentToken(parent: string): AuthGranted | null {
    if (parent.startsWith(CLIENT_URL_PARENT_PREFIX)) {
      if (this.native) return null;
      const id = parent.slice(CLIENT_URL_PARENT_PREFIX.length);
      const client = id !== '' ? this.options.clientStore.getActiveClient(id) : undefined;
      if (client === undefined) return null;
      return { ok: true, scope: 'client', sessionToken: parent, clientId: client.id, client };
    }
    if (verifySessionJwt(this.jwt.secret(), parent, this.options.now())) {
      return { ok: true, scope: 'session', sessionToken: parent };
    }
    return null;
  }

  private byBearer(bearer: string): AuthOutcome {
    const token = bearer.replace(/^Bearer\s+/iu, '');
    const result = this.native ? { ok: false as const } : this.options.clientStore.authenticateBearerToken(token);
    if (!result.ok) {
      return {
        ok: false,
        status: 401,
        body: { error: 'UI authentication required', locked: true },
        clearSessionCookie: false,
        headers: { 'cache-control': NO_STORE },
      };
    }
    return { ok: true, scope: 'client', sessionToken: result.sessionToken, clientId: result.clientId, client: result.client };
  }

  sessionStatus(headers: Headers, url: URL, method: string): RouteAction {
    const outcome = this.authenticate(headers, url, method);
    if (outcome.ok) {
      return {
        status: 200,
        body: {
          authenticated: true,
          scope: outcome.scope,
          authRequired: this.authRequired(),
          methods: this.native ? this.methods() : ['password'],
          passkeys: false,
        },
        headers: { 'cache-control': NO_STORE },
      };
    }
    return {
      status: 401,
      body: { authenticated: false, locked: true, authRequired: this.authRequired(), methods: this.methods() },
      clearSessionCookie: outcome.clearSessionCookie,
      headers: { 'cache-control': NO_STORE },
    };
  }

  login(inputs: LoginInputs): RouteAction {
    const noStore = { 'cache-control': NO_STORE };
    if (!this.nativeRequestAllowed(inputs.headers, inputs.url) || (this.native && !this.passwordRequired())) return this.deniedAction();
    if (!this.passwordRequired()) {
      // Open mode: no cookie is issued; the mint still honors the trustDevice
      // TTL the caller asked for (§2.3 5 "expiresAt equals the cookie TTL").
      const trust = (inputs.body as { trustDevice?: unknown } | null)?.trustDevice === true;
      const mint = this.maybeMintClientToken(inputs.body, trust ? this.options.trustSessionTtlMs : this.options.sessionTtlMs);
      return { status: 200, body: { authenticated: true, ...mint }, headers: noStore };
    }
    const rate = this.limiter.attempt(inputs.ip);
    if (!rate.allowed) {
      return { status: 429, body: { error: 'Too many failed login attempts', locked: true }, clearSessionCookie: true, headers: { ...noStore, ...rateLimitHeaders(rate) } };
    }
    const clearCookie = { clearSessionCookie: true as const, headers: { ...noStore, ...rateLimitHeaders(rate) } };
    if (!this.verifyPassword((inputs.body as { password?: unknown } | null)?.password)) {
      this.limiter.record(inputs.ip);
      return { status: 401, body: { error: 'Invalid credentials' }, ...clearCookie };
    }
    this.limiter.clear(inputs.ip);
    return this.grantedLogin(inputs);
  }

  mintUrlTokenFromRequest(headers: Headers, url: URL, method: string): RouteAction {
    // URL tokens cannot renew themselves: the mint re-runs auth with the URL
    // token branch disabled (doc 08 section 2.6, allowUrlToken:false).
    const outcome = this.authenticate(headers, url, method, false);
    if (!outcome.ok) {
      return { status: outcome.status, body: outcome.body, clearSessionCookie: outcome.clearSessionCookie, headers: { ...outcome.headers } };
    }
    const parent = outcome.scope === 'client' ? `client:${outcome.clientId}` : outcome.scope === 'session' ? outcome.sessionToken : '';
    return { status: 200, body: this.storeUrlToken(parent), headers: { 'cache-control': NO_STORE } };
  }

  storeUrlToken(parent: string): { token: string; expiresAt: string } {
    this.pruneExpiredUrlTokens();
    while (this.urlTokens.size >= this.options.urlTokenBudget) {
      const oldest = this.urlTokens.keys().next();
      if (oldest.done) break;
      this.urlTokens.delete(oldest.value);
    }
    const expiresAt = this.options.now() + this.options.urlTokenTtlMs;
    const token = `oc_url_${randomBytes(24).toString('base64url')}`;
    this.urlTokens.set(token, { parent, expiresAt });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  resolveUrlToken(token: string): string | null {
    this.pruneExpiredUrlTokens();
    const entry = this.urlTokens.get(token);
    if (entry === undefined || entry.expiresAt <= this.options.now()) return null;
    return entry.parent;
  }

  private pruneExpiredUrlTokens(): void {
    const stamp = this.options.now();
    for (const [token, entry] of this.urlTokens) {
      if (entry.expiresAt <= stamp) this.urlTokens.delete(token);
    }
  }

  private maybeMintClientToken(body: unknown, ttlMs: number): Record<string, unknown> {
    if (this.native) return {};
    const request = body as { issueClientToken?: unknown; clientKind?: unknown } | null;
    if (request === null || request.issueClientToken !== true) return {};
    const kind = typeof request.clientKind === 'string' ? request.clientKind : '';
    if (!DESKTOP_MINT_KINDS.has(kind)) return {};
    const meta = body as Record<string, unknown>;
    const stringField = (key: string): string | undefined => {
      const value = meta[key];
      return typeof value === 'string' && value.trim() !== '' ? value : undefined;
    };
    const created = this.options.clientStore.createClient({
      authMethod: 'password',
      clientKind: kind,
      label: stringField('clientLabel'),
      dedupeKey: stringField('dedupeKey'),
      deviceName: stringField('deviceName'),
      devicePlatform: stringField('devicePlatform'),
      deviceModel: stringField('deviceModel'),
      appVersion: stringField('appVersion'),
      expiresAt: new Date(this.options.now() + ttlMs).toISOString(), // equals the cookie TTL (§2.3 5)
    });
    return { clientToken: created.token, client: sanitizeOutboundClient(created.client) };
  }

  /** Global sign-out (§2.2 POST /api/auth/reset): cookie-session-only, rotates
   * the JWT secret (refused while NOTNATIVE_JWT_SECRET is set), clears the
   * cookie. Device tokens never rotate here (revoke via the client routes). */
  resetSessionAuth(headers: Headers): RouteAction {
    const jar = parseCookieHeader(headers.get('cookie'));
    const raw = jar.get(UI_SESSION_COOKIE);
    const stamp = this.options.now();
    if (raw === undefined || !verifySessionJwt(this.jwt.secret(), raw, stamp)) {
      return {
        status: 401,
        body: { error: 'UI authentication required', locked: true },
        clearSessionCookie: raw !== undefined,
        headers: { 'cache-control': NO_STORE },
      };
    }
    try {
      this.jwt.rotate();
      this.native?.invalidate();
      this.urlTokens.clear();
    } catch (error) {
      return { status: 403, body: { error: error instanceof Error ? error.message : String(error) }, headers: { 'cache-control': NO_STORE } };
    }
    return {
      status: 200,
      body: { authenticated: false, reset: true },
      clearSessionCookie: true,
      headers: { 'cache-control': NO_STORE },
    };
  }

  /** Shared login tail for password and passkey logins (§2.3/§2.4): clears
   * the rate bucket, issues the cookie at the trust-device TTL, and mints
   * the desktop client token when asked. */
  grantedLogin(inputs: { ip: string; body: unknown; headers: Headers; url: URL }): RouteAction {
    if (!this.nativeRequestAllowed(inputs.headers, inputs.url)) return this.deniedAction();
    const body = inputs.body as { trustDevice?: unknown } | null;
    const ttl = body?.trustDevice === true ? this.options.trustSessionTtlMs : this.options.sessionTtlMs;
    this.limiter.clear(inputs.ip);
    const mint = this.maybeMintClientToken(inputs.body, ttl);
    return {
      status: 200,
      body: { authenticated: true, ...mint },
      setCookie: sessionCookieHeaderValue(
        this.issueSessionToken(ttl).token, ttl, this.options.now(), secureFromHeaders(inputs.headers, inputs.url),
      ),
      headers: { 'cache-control': NO_STORE },
    };
  }

  /** Limiter passthroughs so the passkey verify route rides the same login
   * rate limit as password login (E-08-21). */
  rateAttemptLogin(ip: string): { allowed: boolean; headers: Record<string, string> } {
    const result = this.limiter.attempt(ip);
    if (result.allowed) return { allowed: true, headers: {} };
    return { allowed: false, headers: { 'cache-control': NO_STORE, ...rateLimitHeaders(result) } };
  }

  rateRecordLogin(ip: string): void {
    this.limiter.record(ip);
  }

  /** Terminal WS upgrade admission (E-07-3 slot): the loopback gate lives in
   * the wire layer; this predicate adds the cookie/URL-token check once the
   * password is configured. */
  upgradeAllowed(url: URL, headers: Headers, method: string): boolean {
    return this.authenticate(headers, url, method).ok;
  }

  /** Bearer + URL-token credentials only (no JWT cookie branch, no open
   * pass-through): the device-token surface that passes at ANY scope (§2.9)
   * and the /auth/session tunnel-scope row. */
  credentialGrant(headers: Headers, url: URL, method: string, urlTokensEnabled: boolean = true): boolean {
    if (!this.nativeRequestAllowed(headers, url)) return false;
    const bearer = headers.get('authorization');
    if (bearer !== null) return this.byBearer(bearer).ok;
    const fromUrlToken = urlTokensEnabled ? this.byUrlToken(headers, url, method) : null;
    if (fromUrlToken !== null) return fromUrlToken.ok;
    return false;
  }
}

/** Composed WS-upgrade admission across scopes (ui + tunnel controllers):
 * at tunnel scope the device-bearing credentials and a tunnel session both
 * admit; otherwise the local ui predicate answers. Used by index.ts. */
export function upgradeAllowedForRequest(url: URL, headers: Headers, method: string): boolean {
  if (!getUiAuthController().nativeRequestAllowed(headers, url)) return false;
  const scope = getTunnelAuthController().classify(headers, url);
  if (scope === 'tunnel' || scope === 'unknown-public') {
    if (getUiAuthController().credentialGrant(headers, url, method)) return true;
    return getTunnelAuthController().requireTunnelSession(headers.get('cookie') ?? undefined);
  }
  return getUiAuthController().upgradeAllowed(url, headers, method);
}

export function defaultResolvePassword(): string {
  // Password source is the doc 08 §2.2 (CLI future, env now) — NOT the
  // settings registry: desktopUiPassword stays accepted-never-returned and
  // is not an auth consumer until the settings/auth UX slice lands (E-08-14).
  return readEnvUiPassword();
}

let singleton: UiAuthController | null = null;

export function getUiAuthController(): UiAuthController {
  if (singleton === null) singleton = createUiAuthController();
  return singleton;
}

export function resetUiAuthForTests(): void {
  singleton?.close();
  singleton = null;
}

export function createUiAuthController(options: UiAuthOptionsInput = {}): UiAuthController {
  return new UiAuthController(options);
}

export function installNativeUiAuth(identity: NativeUiIdentity): { controller: UiAuthController; release(): void } {
  if (singleton !== null) throw new Error('UI authentication controller is already initialized');
  const controller = new UiAuthController({ nativeAuth: identity });
  singleton = controller;
  return { controller, release: () => { controller.close(); if (singleton === controller) singleton = null; } };
}
