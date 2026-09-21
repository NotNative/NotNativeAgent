// SPDX-License-Identifier: Apache-2.0
/**
 * Pairing session store (doc 08 section 5.4): one-time, expiring,
 * revocable grants that turn a device into a token-bearing client.
 * `<data-dir>/client-pairing-sessions.json` (version 1, 0o600 atomic).
 * Plaintext secrets exist only inside the one-time create/redeem reply —
 * the file keeps sha256 hashes and every list view strips them. The
 * redeem error is ONE string for missing/cancelled/used/expired/kind
 * failures (indistinguishable attacker class, section 5.4). Mutations
 * run on the synchronous store quiescence of the event loop — the
 * E-08-32 note pins why no promise queue is needed here. Every op also
 * re-reads the file FIRST (refreshFromDisk): the P8-5c CLI writes sessions
 * from a side process (doc 08 section 5.9), so the file is the cross-process
 * source of truth and a boot-time singleton (the live server) still sees
 * CLI-created sessions; the sync op between reload and save keeps the
 * cross-process window at documented last-writer-wins microseconds, the
 * same posture as the relay identity lazy mint (E-08-23/E-08-25c).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { ENV as envDefault } from '../../env.ts';
import type { CreateClientInput, CreatedClient } from './remote-clients.ts';
import { getUiAuthController } from './ui-auth.ts';

export const PAIRING_ID_PREFIX = 'pair_';
export const PAIRING_TTL_MS = 10 * 60_000;
export const PAIRING_LABEL_MAX = 80;
export const INVALID_PAIRING_SESSION_ERROR = 'Invalid or expired pairing session';
export const DEFAULT_ALLOWED_CLIENT_KINDS = ['mobile', 'desktop'] as const;
const KIND_VOCABULARY = ['mobile', 'desktop'] as const;

/** The §5.4 one-generic-error contract, typed (not just the string): the
 * redeem route must never answer a SERVER fault with the attacker-facing
 * generic text or charge its rate bucket — only this class maps there. */
export class InvalidPairingSessionError extends Error {
  constructor() {
    super(INVALID_PAIRING_SESSION_ERROR);
    this.name = 'InvalidPairingSessionError';
  }
}

/** Store WRITE failure after the redeem already minted (rolled back in
 * memory, retried safely): a server fault, never an auth class. */
export class PairingStoreFault extends Error {
  constructor(cause: string) {
    super(`pairing store write failed: ${cause}`);
    this.name = 'PairingStoreFault';
  }
}

export type PairingClientKind = (typeof KIND_VOCABULARY)[number];

export interface PairingSessionRecord {
  id: string;
  secretHash: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  cancelledAt: string | null;
  clientId: string | null;
  label: string | null;
  fingerprint: string;
  allowedClientKinds: string[];
  createdByClientId: string | null;
  usesRelay: boolean;
}

interface PairingStoreShape { version: 1; sessions: PairingSessionRecord[] }

/** Public view: everything except secretHash (and never the secret). */
export type PublicPairingSession = Omit<PairingSessionRecord, 'secretHash'>;
/** One-time view (create reply): public fields + the plaintext secret. */
export type OneTimePairingSession = PublicPairingSession & { secret: string };

export interface CreatePairingInput {
  label?: string | null;
  allowedClientKinds?: string[];
  createdByClientId?: string | null;
  usesRelay?: boolean;
}

/** Redeem-input minting seam: normally the shared RemoteClientStore
 * (routes wire it through the ui-auth controller); tests substitute. */
export type PairingMint = (input: CreateClientInput) => CreatedClient;

export interface RedeemPairingInput {
  pairingId: unknown;
  secret: unknown;
  clientLabel?: unknown;
  clientKind?: unknown;
  deviceName?: unknown;
  devicePlatform?: unknown;
  deviceModel?: unknown;
  appVersion?: unknown;
  dedupeKey?: unknown;
}

export interface PairingRedeemOutcome {
  pairing: PublicPairingSession;
  client: CreatedClient['client'];
  token: string;
}

export interface PairingStoreOptions {
  dataDir?: string;
  now?: () => number;
  mintClient?: PairingMint;
}

export class MintFailure extends Error {
  constructor(cause: string) {
    super(`client token mint failed: ${cause}`);
    this.name = 'MintFailure';
  }
}

export class PairingSessionStore {
  private sessions: PairingSessionRecord[] = [];
  private readonly dataDir: string;
  private readonly now: () => number;
  private readonly mintClient: PairingMint;

  constructor(options: PairingStoreOptions = {}) {
    this.dataDir = options.dataDir ?? envDataDir();
    this.now = options.now ?? Date.now;
    this.mintClient = options.mintClient ?? defaultMint;
    this.load();
  }

  private path(): string { return `${this.dataDir}/client-pairing-sessions.json`; }

  private load(): void {
    try {
      const raw = readFileSync(this.path(), 'utf8');
      const parsed = JSON.parse(raw) as PairingStoreShape;
      this.sessions = (Array.isArray(parsed?.sessions) ? parsed.sessions : [])
        .flatMap((session) => (isUsableSession(session) ? [session] : []));
    } catch {
      this.sessions = []; // corrupt store = no known sessions (fail-safe: no link can redeem what we never knew)
    }
  }

  /** Op-start re-read (see header): disk is the cross-process truth; the
   *  window between this and this op's own save is sync-only microseconds. */
  private refreshFromDisk(): void {
    this.load();
  }

  private save(): void {
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 }); // file 0600 into the 0o700 dir (§12.2)
    // Two concurrent CLI runtimes could pick the same millisecond; the pid
    // makes the tmp name per-writer (same discipline as identity/relay-config).
    const tmp = `${this.path()}.tmp-${process.pid}-${this.now()}`;
    writeFileSync(tmp, JSON.stringify({ version: 1, sessions: this.sessions } satisfies PairingStoreShape), { mode: 0o600 });
    renameSync(tmp, this.path());
  }

  /** Used/cancelled sessions survive until inactiveAt+TTL (the pending
   * audit trail, section 5.4 "Sweeping"); unredeemed drop once expired. */
  private sweep(): void {
    const stamp = this.now();
    this.sessions = this.sessions.filter((session) => {
      const inactiveIso = session.cancelledAt ?? session.usedAt;
      if (inactiveIso !== null) return stamp < Date.parse(inactiveIso) + PAIRING_TTL_MS;
      return Date.parse(session.expiresAt) > stamp;
    });
  }

  createPairingSession(input: CreatePairingInput): OneTimePairingSession {
    this.refreshFromDisk();
    this.sweep();
    const stamp = this.now();
    const secret = randomBytes(32).toString('base64url');
    const record: PairingSessionRecord = {
      id: PAIRING_ID_PREFIX + randomBytes(12).toString('hex'),
      secretHash: sha256Hex(secret),
      createdAt: iso(stamp),
      expiresAt: iso(stamp + PAIRING_TTL_MS),
      usedAt: null,
      cancelledAt: null,
      clientId: null,
      label: normalizeLabel(input.label),
      fingerprint: fingerprint(),
      allowedClientKinds: normalizeKinds(input.allowedClientKinds),
      createdByClientId: typeof input.createdByClientId === 'string' && input.createdByClientId !== '' ? input.createdByClientId : null,
      usesRelay: input.usesRelay === true,
    };
    this.sessions.push(record);
    this.save();
    return { ...publicView(record), secret };
  }

  /** Pending = not used ∧ not cancelled ∧ not expired (public, no secrets). */
  listPendingSessions(): PublicPairingSession[] {
    this.refreshFromDisk();
    const stamp = this.now();
    return this.sessions
      .filter((session) => session.usedAt === null && session.cancelledAt === null && Date.parse(session.expiresAt) > stamp)
      .map(publicView);
  }

  /** Relay-demand signal (section 3.12): any still-redeemable relay session. */
  hasActiveRelaySession(): boolean {
    this.refreshFromDisk();
    const stamp = this.now();
    return this.sessions.some((session) => session.usesRelay && session.usedAt === null
      && session.cancelledAt === null && Date.parse(session.expiresAt) > stamp);
  }

  findSession(id: unknown): PublicPairingSession | undefined {
    this.refreshFromDisk();
    if (typeof id !== 'string' || id === '') return undefined;
    const record = this.sessions.find((session) => session.id === id);
    return record === undefined ? undefined : publicView(record);
  }

  /** Idempotent stamp; an already-cancelled or unknown (or already-used —
   * a one-time grant has nothing left to revoke; E-08-33g) session answers
   * {cancelled,false} — the route maps that to 404 ("unknown/already gone"). */
  cancelPairingSession(id: string): { cancelled: boolean; pairing: PublicPairingSession | null } {
    this.refreshFromDisk();
    const record = this.sessions.find((session) => session.id === id);
    if (record === undefined) return { cancelled: false, pairing: null };
    if (record.cancelledAt !== null || record.usedAt !== null) return { cancelled: false, pairing: publicView(record) };
    record.cancelledAt = iso(this.now());
    this.save();
    return { cancelled: true, pairing: publicView(record) };
  }

  /** section 5.4 redeem: the ONLY op that consumes the secret. Auth-class
   * failures throw InvalidPairingSessionError (typed, one message); mint
   * failure leaves the session redeemable (retry-safe); a STORE-write
   * failure after the mint rolls the stamp back and throws
   * PairingStoreFault (server fault, retry-safe the same way). */
  redeemPairingSession(input: RedeemPairingInput, overrideMint?: PairingMint): PairingRedeemOutcome {
    const pairingId = stringOf(input.pairingId);
    const secret = stringOf(input.secret);
    if (pairingId === '' || secret === '') throw new InvalidPairingSessionError();
    this.refreshFromDisk();
    this.sweep();
    const record = this.sessions.find((session) => session.id === pairingId);
    if (record === undefined) throw new InvalidPairingSessionError();
    if (record.cancelledAt !== null) throw new InvalidPairingSessionError();
    if (record.usedAt !== null) throw new InvalidPairingSessionError();
    if (Date.parse(record.expiresAt) <= this.now()) throw new InvalidPairingSessionError();
    const clientKind = stringOf(input.clientKind) || 'mobile';
    if (!record.allowedClientKinds.includes(clientKind)) throw new InvalidPairingSessionError();
    if (!sameHash(sha256Hex(secret), record.secretHash)) throw new InvalidPairingSessionError();
    const mint = overrideMint ?? this.mintClient;
    const created = this.safeMint(mint, {
      authMethod: 'pairing',
      pairingId: record.id,
      dedupeKey: stringOf(input.dedupeKey) || `pairing:${record.id}`,
      ...(record.label !== null ? { label: record.label } : {}),
      fallbackLabel: firstMeaningful(stringOf(input.clientLabel), stringOf(input.deviceName)) || 'Remote client',
      clientKind,
      usesRelay: record.usesRelay,
      deviceName: stringOf(input.deviceName) || undefined,
      devicePlatform: stringOf(input.devicePlatform) || undefined,
      deviceModel: stringOf(input.deviceModel) || undefined,
      appVersion: stringOf(input.appVersion) || undefined,
    });
    const stamp = iso(this.now());
    record.usedAt = stamp;
    record.clientId = created.client.id;
    try {
      this.save();
    } catch (error) {
      // consume-on-confirm: a failed write rewinds the stamp (retry-safe)
      record.usedAt = null;
      record.clientId = null;
      throw new PairingStoreFault(error instanceof Error ? error.message : String(error));
    }
    return { pairing: publicView(record), client: created.client, token: created.token };
  }

  private safeMint(mint: PairingMint, nested: CreateClientInput): CreatedClient {
    try {
      return mint(nested);
    } catch (error) {
      throw new MintFailure(error instanceof Error ? error.message : String(error));
    }
  }
}

// —— singletons (options honored on the FIRST construction only) --------------

let singleton: PairingSessionStore | null = null;

export function getPairingSessionStore(options?: PairingStoreOptions): PairingSessionStore {
  if (singleton === null) singleton = createPairingSessionStore(options);
  return singleton;
}

export function createPairingSessionStore(options?: PairingStoreOptions): PairingSessionStore {
  return new PairingSessionStore(options ?? {});
}

export function resetPairingSessionStoreForTests(): void {
  singleton = null;
}

// —— helpers ------------------------------------------------------------------

function defaultMint(input: CreateClientInput): CreatedClient {
  // The process-wide ui-auth controller owns the shared client store; the
  // app wiring may pass its own mint through store options (tests do).
  return getUiAuthController().getClientStore().createClient(input);
}

function iso(stamp: number): string { return new Date(stamp).toISOString(); }

function normalizeLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null; // "Pair new device" display placeholders are never persisted
  return trimmed.slice(0, PAIRING_LABEL_MAX);
}

function normalizeKinds(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_ALLOWED_CLIENT_KINDS];
  const picked = [...new Set(value.filter((kind): kind is PairingClientKind => (typeof kind === 'string')
    && (KIND_VOCABULARY as readonly string[]).includes(kind)))];
  return picked.length > 0 ? picked : [...DEFAULT_ALLOWED_CLIENT_KINDS];
}

function fingerprint(): string {
  const hex = randomBytes(4).toString('hex').toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4)}`;
}

function publicView(record: PairingSessionRecord): PublicPairingSession {
  const { secretHash: _secret, ...rest } = record as PairingSessionRecord & { secretHash?: string };
  void _secret;
  return { ...rest };
}

function isUsableSession(value: unknown): value is PairingSessionRecord {
  if (typeof value !== 'object' || value === null) return false;
  const session = value as Partial<PairingSessionRecord>;
  return typeof session.id === 'string' && session.id.startsWith(PAIRING_ID_PREFIX)
    && typeof session.secretHash === 'string'
    && typeof session.createdAt === 'string' && typeof session.expiresAt === 'string'
    && (session.usedAt === null || typeof session.usedAt === 'string')
    && (session.cancelledAt === null || typeof session.cancelledAt === 'string')
    && (session.clientId === null || typeof session.clientId === 'string')
    && typeof session.fingerprint === 'string'
    && Array.isArray(session.allowedClientKinds)
    && typeof session.usesRelay === 'boolean';
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function firstMeaningful(...values: string[]): string {
  return values.find((value) => value !== '') ?? '';
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sameHash(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  try {
    return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
  } catch {
    return false;
  }
}

/** No-store-section default: the boot wires ENV.dataDir (which itself
 * honors NOTNATIVE_DATA_DIR with the homedir fallback) so a stock launch
 * never constructs a rootless `''` path (review P0). */
function envDataDir(): string {
  return envDefault.dataDir;
}
