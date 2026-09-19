// SPDX-License-Identifier: Apache-2.0
/**
 * Tunnel-gated auth (doc 08 sections 2.9/4.5/4.7): request-scope
 * classification (tunnel host match -> local names with private/loopback
 * sockets -> no-tunnel default local -> unknown-public treated like
 * tunnel), newest-only bootstrap tokens (32 B base64url, sha256-at-rest,
 * one-time redeem), in-memory tunnel sessions (cookie `oc_tunnel_session`,
 * HttpOnly/SameSite=Lax), the connect rate limit (20/5min per IP, 5
 * without, 10 min lock), and artifact revocation on stop/replace.
 * IPv4-mapped `::ffff:` sockets classify as their IPv4 space (dual-stack
 * binds; parity with the wire.ts loopback peer cap).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createLoginRateLimiter, rateLimitHeaders, type LoginRateLimitConfig } from './rate-limit.ts';

export type RequestScope = 'tunnel' | 'local' | 'unknown-public';

export interface ActiveTunnel {
  tunnelId: string;
  publicUrl: string;
  mode: string;
  host: string; // normalized (lowercase, port-stripped) host of the public URL
}

export interface BootstrapTokenRecord {
  id: string;
  tunnelId: string;
  tokenHash: string;
  issuedAt: string;
  expiresAt: string | null; // null = no expiry (doc 08 section 4.5)
  usedAt: string | null;
  revokedAt: string | null;
}

export interface TunnelSession {
  sessionId: string;
  tunnelId: string;
  mode: string;
  publicUrl: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
}

export const TUNNEL_COOKIE_NAME = 'oc_tunnel_session';
export const TUNNEL_REDEEM_FAILURE_TEXT = 'Connection link is invalid or expired.';
export const CLEAR_TUNNEL_COOKIE_HEADER = `${TUNNEL_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;

const BOOTSTRAP_TTL_DEFAULT_MS = 30 * 60_000;
const BOOTSTRAP_TTL_MIN_MS = 60_000;
const BOOTSTRAP_TTL_MAX_MS = 24 * 60 * 60_000;
const SESSION_TTL_DEFAULT_MS = 8 * 60 * 60_000;
const SESSION_TTL_MIN_MS = 5 * 60_000;
const SESSION_TTL_MAX_MS = 30 * 24 * 60 * 60_000;
const SESSION_MAP_BUDGET = 512;

export interface ClampedTtl {
  enabled: boolean;
  ms: number;
}

/** Bootstrap TTL: default 30 min, clamp 1 min-24 h; `null` disables expiry. */
export function clampBootstrapTtl(value: number | null | undefined): ClampedTtl {
  if (value === null) return { enabled: false, ms: Number.MAX_SAFE_INTEGER };
  const base = typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : BOOTSTRAP_TTL_DEFAULT_MS;
  return { enabled: true, ms: Math.min(BOOTSTRAP_TTL_MAX_MS, Math.max(BOOTSTRAP_TTL_MIN_MS, base)) };
}

/** Session TTL: default 8 h, clamp 5 min-30 d. */
export function clampSessionTtl(value: number | undefined): number {
  const base = typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : SESSION_TTL_DEFAULT_MS;
  return Math.min(SESSION_TTL_MAX_MS, Math.max(SESSION_TTL_MIN_MS, base));
}

export function normalizedHost(value: unknown): string {
  if (typeof value !== 'string') return '';
  let host = value.trim().toLowerCase();
  if (host === '') return '';
  if (host.startsWith('[')) { // Host: [::1]:8080
    const end = host.indexOf(']');
    return end === -1 ? host.slice(1) : host.slice(1, end);
  }
  const colon = host.lastIndexOf(':');
  if (colon > 0 && host.indexOf(':') === colon) host = host.slice(0, colon); // single-colon port strip
  return host;
}

function isLocalHostname(host: string): boolean {
  if (host === '') return false;
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

function isPrivateAddress(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw === '') return false;
  const address = raw.toLowerCase();
  // Node reports IPv4 peers as ::ffff:a.b.c.d on dual-stack binds (the form
  // wire.ts isLoopbackPeer already accepts for loopback): map back to the
  // IPv4 space or the desktop's own LAN/loopback traffic would misclassify
  // as public the moment a tunnel is armed.
  if (address.startsWith('::ffff:')) return isPrivateV4(address.slice(7));
  if (address.includes(':')) {
    return address === '::1' || address === '[::1]' || address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe80');
  }
  return isPrivateV4(address);
}

/** IPv4 literals only (any `::ffff:` prefix is stripped by the caller). */
function isPrivateV4(address: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/u.test(address)) return false;
  const parts = address.split('.').map(Number);
  for (const part of parts) if (part > 255) return false;
  const [a, b] = parts as [number, number];
  return a === 10
    || a === 127
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254);
}

export type ConnectGrant =
  | { ok: true; session: TunnelSession; cookieValue: string; redirectTo: string }
  | { ok: false; status: number; body: string };

export interface TunnelAuthOptionsInput {
  now?: () => number;
  bootstrapTtlMs?: number | null;
  sessionTtlMs?: number;
  rate?: Partial<LoginRateLimitConfig>;
}

export function createTunnelAuthController(options: TunnelAuthOptionsInput = {}): TunnelAuthController {
  return new TunnelAuthController(options);
}

export class TunnelAuthController {
  private active: ActiveTunnel | null = null;
  private bootstrap: BootstrapTokenRecord | null = null;
  private readonly sessions = new Map<string, TunnelSession>();
  private readonly limiter;
  private readonly now: () => number;
  private sessionTtlMs: number;
  private bootstrapTtlState: ClampedTtl;

  constructor(options: TunnelAuthOptionsInput = {}) {
    this.now = options.now ?? Date.now;
    this.sessionTtlMs = clampSessionTtl(options.sessionTtlMs);
    this.bootstrapTtlState = clampBootstrapTtl(options.bootstrapTtlMs);
    this.limiter = createLoginRateLimiter({
      windowMs: 5 * 60_000,
      maxAttempts: 20,
      noIpMaxAttempts: 5,
      lockoutMs: 10 * 60_000,
      ...options.rate,
    }, this.now);
  }

  /** Runtime TTL update hook (the tunnels slice wires settings writes here). */
  applyBootstrapTtl(value: number | null): void {
    this.bootstrapTtlState = clampBootstrapTtl(value);
  }

  applySessionTtl(value: number): void {
    this.sessionTtlMs = clampSessionTtl(value);
  }

  get bootstrapTtl(): ClampedTtl {
    return this.bootstrapTtlState;
  }

  get sessionTtl(): number {
    return this.sessionTtlMs;
  }

  /** Expiry of the live bootstrap token (status.ttlConfig + start responses;
   * null = no expiry configured). */
  bootstrapExpiresAt(): string | null {
    return this.bootstrap?.expiresAt ?? null;
  }

  /** status.hasBootstrapToken anchor (`null` expiry must still read true). */
  hasLiveBootstrapToken(): boolean {
    return this.bootstrap !== null && this.bootstrap.usedAt === null && this.bootstrap.revokedAt === null;
  }

  /** §4.7 start-failure cleanup: the active record is cleared without
   * revoking artifacts (the previous tunnel keeps whatever auth state it
   * granted; failure must not punish its visitors). */
  detachActiveTunnel(): void {
    this.active = null;
    this.bootstrap = null;
  }

  activeTunnel(): ActiveTunnel | null {
    return this.active;
  }

  /** Records the active tunnel (doc 08 section 4.5). The normalized host of
   * publicUrl drives scope classification (§2.9). */
  setActiveTunnel(input: { tunnelId?: string; publicUrl: string; mode: string }): ActiveTunnel {
    this.active = {
      tunnelId: typeof input.tunnelId === 'string' && input.tunnelId !== '' ? input.tunnelId : `tnl_${randomBytes(12).toString('hex')}`,
      publicUrl: typeof input.publicUrl === 'string' ? input.publicUrl : '',
      mode: typeof input.mode === 'string' ? input.mode : 'quick',
      host: normalizedHost(urlHostname(input.publicUrl)),
    };
    return this.active;
  }

  /** Stop/replace cleanup (§4.7): revokes the tunnel's token and every live
   * session, then clears the active record. */
  clearActiveTunnel(): { revokedBootstrapCount: number; invalidatedSessionCount: number } {
    const matches = this.bootstrap !== null && this.bootstrap.revokedAt === null;
    const revokedBootstrapCount = matches ? 1 : 0;
    if (matches) this.bootstrap!.revokedAt = new Date(this.now()).toISOString();
    const invalidatedSessionCount = this.revokeSessionsOf(this.active?.tunnelId ?? '', 'tunnel-revoked');
    this.bootstrap = null;
    this.active = null;
    return { revokedBootstrapCount, invalidatedSessionCount };
  }

  /** Newest-only: issuance revokes the previous token first (§4.5), then
   * replaces it with the newest connect link. */
  issueBootstrapToken(): { token: string; record: BootstrapTokenRecord } {
    if (this.active === null) throw new Error('an active tunnel is required to issue a bootstrap token');
    const stamp = this.now();
    const previous = this.bootstrap;
    if (previous !== null && previous.revokedAt === null) previous.revokedAt = new Date(stamp).toISOString();
    const token = randomBytes(32).toString('base64url');
    const record: BootstrapTokenRecord = {
      id: randomBytes(12).toString('hex'),
      tunnelId: this.active.tunnelId,
      tokenHash: sha256Hex(token),
      issuedAt: new Date(stamp).toISOString(),
      expiresAt: this.bootstrapTtl.enabled ? new Date(stamp + this.bootstrapTtl.ms).toISOString() : null,
      usedAt: null,
      revokedAt: null,
    };
    this.bootstrap = record;
    return { token, record };
  }

  /** One-time exchange (§4.5 connect route): sha256 compare against the
   * newest token; unused/unrevoked/unexpired + tunnel match required. */
  redeemToken(token: unknown): ConnectGrant {
    if (this.active === null || typeof token !== 'string' || token === '') return deniedGrant();
    const record = this.bootstrap;
    const stamp = this.now();
    if (record === null
      || record.revokedAt !== null
      || record.usedAt !== null
      || record.tunnelId !== this.active.tunnelId) {
      return deniedGrant();
    }
    if (!ConstantHashEqual(record.tokenHash, sha256Hex(token))) return deniedGrant();
    if (record.expiresAt !== null) {
      const expiry = Date.parse(record.expiresAt);
      if (!Number.isFinite(expiry) || expiry <= stamp) return deniedGrant();
    }
    // Doc 08 section 4.5 order: mint the session first, then mark the token
    // used, so a session mint failure can never strand a consumed one-time
    // token with nothing issued in its place.
    const session: TunnelSession = {
      sessionId: randomBytes(32).toString('base64url'),
      tunnelId: record.tunnelId,
      mode: this.active.mode,
      publicUrl: this.active.publicUrl,
      createdAt: new Date(stamp).toISOString(),
      lastSeenAt: new Date(stamp).toISOString(),
      expiresAt: new Date(stamp + this.sessionTtlMs).toISOString(),
      revokedAt: null,
      revokedReason: null,
    };
    this.sessions.set(session.sessionId, session);
    record.usedAt = new Date(stamp).toISOString();
    this.pruneSessions();
    const maxAge = Math.floor(this.sessionTtlMs / 1000);
    return {
      ok: true,
      session,
      redirectTo: '/',
      cookieValue: `${TUNNEL_COOKIE_NAME}=${session.sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
    };
  }

  /** Cookie -> session (§4.5): revoked/expired/wrong-tunnel reject;
   * lastSeenAt refreshes on every hit. */
  sessionFromCookie(cookieHeader: string | null | undefined): TunnelSession | null {
    if (typeof cookieHeader !== 'string') return null;
    const id = parseCookieHeader(cookieHeader).get(TUNNEL_COOKIE_NAME);
    if (id === undefined || id === '') return null;
    const session = this.sessions.get(id);
    if (session === undefined || session.revokedAt !== null) return null;
    const stamp = this.now();
    if (Date.parse(session.expiresAt) <= stamp) return null;
    if (this.active === null || session.tunnelId !== this.active.tunnelId) return null;
    session.lastSeenAt = new Date(stamp).toISOString();
    return session;
  }

  /** /api gate at tunnel scope (§2.9). */
  requireTunnelSession(cookieHeader: string | null | undefined): boolean {
    return this.sessionFromCookie(cookieHeader) !== null;
  }

  /** §2.9 classifier: 1) tunnel host match -> tunnel; 2) local name with a
   * private/loopback socket -> local; 3) no active tunnel -> local;
   * 4) otherwise unknown-public (treated exactly like tunnel). The URL
   * hostname backs the Host header (constructed requests carry none); an
   * unknown socket counts as the loopback desktop host (wire.ts stance). */
  classify(headers: Headers, url: URL, socketAddress?: string): RequestScope {
    const host = normalizedHost(headers.get('host') ?? url.hostname);
    if (this.active !== null && host !== '' && host === this.active.host) return 'tunnel';
    const localSocket = socketAddress === undefined || isPrivateAddress(socketAddress);
    if (isLocalHostname(host) && localSocket) return 'local';
    if (this.active === null) return 'local';
    return 'unknown-public';
  }

  attemptConnect(headers: Headers, socketAddress?: string): { allowed: boolean; headers: Record<string, string> } {
    const result = this.limiter.attempt(firstForwardedIp(headers, socketAddress));
    if (result.allowed) return { allowed: true, headers: {} };
    return { allowed: false, headers: { 'cache-control': 'no-store', ...rateLimitHeaders(result) } };
  }

  recordConnectFailure(headers: Headers, socketAddress?: string): void {
    this.limiter.record(firstForwardedIp(headers, socketAddress));
  }

  sessionList(): TunnelSession[] {
    return [...this.sessions.values()];
  }

  /** Replacement revoke (§4.7): revokes artifacts bound to the given id and
   * marks its sessions; the active record is untouched. */
  revokeTunnelArtifacts(previousTunnelId: string): { revokedBootstrapCount: number; invalidatedSessionCount: number } {
    const stamp = new Date(this.now()).toISOString();
    const matches = this.bootstrap !== null && this.bootstrap.tunnelId === previousTunnelId && this.bootstrap.revokedAt === null;
    const revokedBootstrapCount = matches ? 1 : 0;
    if (matches) this.bootstrap!.revokedAt = stamp;
    const invalidatedSessionCount = this.revokeSessionsOf(previousTunnelId, 'tunnel-revoked');
    return { revokedBootstrapCount, invalidatedSessionCount };
  }

  private revokeSessionsOf(tunnelId: string, reason: string): number {
    const stamp = new Date(this.now()).toISOString();
    let invalidated = 0;
    for (const session of this.sessions.values()) {
      if (session.tunnelId === tunnelId && session.revokedAt === null) {
        session.revokedAt = stamp;
        session.revokedReason = reason;
        invalidated += 1;
      }
    }
    return invalidated;
  }

  private pruneSessions(): void {
    while (this.sessions.size > SESSION_MAP_BUDGET) {
      const oldest = this.sessions.keys().next();
      if (oldest.done) break;
      this.sessions.delete(oldest.value);
    }
  }
}

function deniedGrant(): ConnectGrant {
  return { ok: false, status: 401, body: TUNNEL_REDEEM_FAILURE_TEXT };
}

function ConstantHashEqual(left: string, right: string): boolean {
  try {
    return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
  } catch {
    return false;
  }
}

function urlHostname(publicUrl: string): string {
  try {
    return new URL(publicUrl).hostname;
  } catch {
    return '';
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** §4.5 connect limiter key: the SOCKET address first — an unauthenticated
 * surface never trusts the client-printed IP (doc 03 §8.5 anti-spoof);
 * XFF is only the in-process/no-socket fallback. */
export function firstForwardedIp(headers: Headers, socketAddress?: string): string {
  if (typeof socketAddress === 'string' && socketAddress !== '') return socketAddress;
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded !== null) {
    const first = forwarded.split(',')[0]?.trim() ?? '';
    if (first !== '') return first;
  }
  return '';
}

export function parseCookieHeader(header: string): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name !== '') jar.set(name, value);
  }
  return jar;
}

let singleton: TunnelAuthController | null = null;

export function getTunnelAuthController(): TunnelAuthController {
  if (singleton === null) singleton = createTunnelAuthController();
  return singleton;
}

export function resetTunnelAuthForTests(): void {
  singleton = null;
}
