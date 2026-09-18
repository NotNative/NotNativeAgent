// SPDX-License-Identifier: Apache-2.0
/**
 * Trusted-device client tokens (doc 08 section 2.7): `oc_client_` + 32
 * random bytes base64url; ONLY sha256(token) hex is stored - plaintext
 * exists exactly once at creation/redemption. Dedupe-replace semantics with
 * label precedence (explicit > replaced record > fallback), kind-tagged
 * dedupes clean legacy untagged records, revoke/purge lifecycle, transport
 * classification with the 60 s lastUsed write throttle, and the authority
 * rules (self-revoke for any token; desktop-local/session revoke anything).
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export const CLIENT_TOKEN_PREFIX = 'oc_client_';
export const CLIENT_LABEL_MAX = 80;
const LASTUSED_WRITE_THROTTLE_MS = 60_000;

export type ClientKind = 'mobile' | 'desktop' | 'desktop-local' | string;
export type AuthMethod = 'password' | 'passkey' | 'pairing';

export interface RemoteClientRecord {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string;
  revokedAt: string | null;
  expiresAt?: string;
  tokenHash: string;
  clientKind: ClientKind;
  dedupeKey?: string;
  usesRelay: boolean;
  lastTransport: 'relay' | 'direct';
  authMethod?: AuthMethod;
  pairingId?: string;
  deviceName?: string;
  devicePlatform?: string;
  deviceModel?: string;
  appVersion?: string;
}

interface ClientStoreShape { version: 1; clients: RemoteClientRecord[] }

export interface CreateClientInput {
  authMethod?: AuthMethod;
  dedupeKey?: string;
  clientKind?: ClientKind;
  label?: string;
  fallbackLabel?: string;
  pairingId?: string;
  usesRelay?: boolean;
  deviceName?: string;
  devicePlatform?: string;
  deviceModel?: string;
  appVersion?: string;
  expiresAt?: string;
}

export interface CreatedClient {
  client: RemoteClientRecord;
  token: string; // returned exactly once (section 2.7)
}

export interface BearerTransportHint { relayConnection: boolean }

export class ClientAuthError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class RemoteClientStore {
  private clients: RemoteClientRecord[] = [];
  private lastWriteStamp = new Map<string, { stamp: number; transport: 'relay' | 'direct' }>();
  private readonly dataDir: string;
  private readonly now: () => number;

  constructor(dataDir: string, now: () => number = Date.now) {
    this.dataDir = dataDir;
    this.now = typeof now === 'function' ? now : Date.now;
    this.load();
  }

  private path(): string { return `${this.dataDir}/remote-clients.json`; }

  private load(): void {
    try {
      const raw = readFileSync(this.path(), 'utf8');
      const parsed = JSON.parse(raw) as ClientStoreShape;
      this.clients = (Array.isArray(parsed?.clients) ? parsed.clients : []).filter(isUsableRecord);
    } catch {
      this.clients = [];
    }
  }

  /** Atomic tmp+rename write (mirrors settings-store): a mid-write crash can
   * never turn a truncated file into an empty client inventory on reload. */
  private save(): void {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const tmp = `${this.path()}.tmp-${process.pid}-${this.now()}`;
      writeFileSync(tmp, JSON.stringify({ version: 1, clients: this.clients } satisfies ClientStoreShape), { mode: 0o600 });
      renameSync(tmp, this.path());
    } catch { /* store stays in memory on write failure */ }
  }

  /** Dedupe key replaces the prior record; the keep rule is documented in
   * section 5.4 (label precedence below). */
  createClient(input: CreateClientInput): CreatedClient {
    const kind = input.clientKind === undefined || input.clientKind === '' ? 'mobile' : input.clientKind;
    const dedupeKey = input.dedupeKey !== undefined && input.dedupeKey !== '' ? input.dedupeKey : undefined;
    const previous = dedupeKey !== undefined ? this.clients.find((client) => client.dedupeKey === dedupeKey && client.revokedAt === null) : undefined;
    const label = resolveLabel(input, previous);
    if (previous !== undefined) {
      const priorId = previous.id;
      const legacy = this.clients.filter((client) => client.revokedAt === null && client.dedupeKey === undefined && client.label === label && client.id !== priorId);
      if (legacy.length > 0) {
        const deadIds = new Set(legacy.map((client) => client.id));
        this.clients = this.clients.filter((client) => !deadIds.has(client.id));
        for (const dead of deadIds) this.lastWriteStamp.delete(dead);
      }
      this.clients = this.clients.filter((client) => client.id !== priorId);
      this.lastWriteStamp.delete(priorId);
    }
    const token = CLIENT_TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const record: RemoteClientRecord = {
      id: randomUUID().replace(/-/gu, '').slice(0, 24),
      label,
      createdAt: new Date(this.now()).toISOString(),
      lastUsedAt: new Date(this.now()).toISOString(),
      revokedAt: null,
      ...(typeof input.expiresAt === 'string' ? { expiresAt: input.expiresAt } : {}),
      tokenHash: sha256Hex(token),
      clientKind: kind,
      ...(dedupeKey !== undefined ? { dedupeKey } : {}),
      usesRelay: input.usesRelay === true,
      lastTransport: 'direct',
      ...(input.authMethod !== undefined ? { authMethod: input.authMethod } : {}),
      ...(input.pairingId !== undefined ? { pairingId: input.pairingId } : {}),
      ...(input.deviceName !== undefined ? { deviceName: input.deviceName } : {}),
      ...(input.devicePlatform !== undefined ? { devicePlatform: input.devicePlatform } : {}),
      ...(input.deviceModel !== undefined ? { deviceModel: input.deviceModel } : {}),
      ...(input.appVersion !== undefined ? { appVersion: input.appVersion } : {}),
    };
    this.clients.push(record);
    this.save();
    return { client: record, token };
  }

  /** Bearer authentication: prefix + constant-time hash compare; revoked
   * and expired records fail; relay-origin requests stamp the sticky
   * usesRelay flag (self-heal, never cleared by LAN requests). */
  authenticateBearerToken(token: string, transport: BearerTransportHint = { relayConnection: false }): { ok: true; clientId: string; sessionToken: string; client: RemoteClientRecord } | { ok: false; status: number; error: string } {
    if (!token.startsWith(CLIENT_TOKEN_PREFIX)) return { ok: false, status: 401, error: 'UI authentication required' };
    const hash = sha256Hex(token);
    const record = this.clients.find((client) => client.tokenHash.length === hash.length && equalHex(client.tokenHash, hash));
    if (record === undefined) return { ok: false, status: 401, error: 'UI authentication required' };
    if (record.revokedAt !== null) return { ok: false, status: 401, error: 'UI authentication required' };
    if (record.expiresAt !== undefined) {
      // Unparsable expiry fails closed (fail-open would resurrect the record
      // forever; the relay-demand signal already excludes unparsable).
      const expiry = Date.parse(record.expiresAt);
      if (!Number.isFinite(expiry) || expiry <= this.now()) return { ok: false, status: 401, error: 'UI authentication required' };
    }
    const transportNow: 'relay' | 'direct' = transport.relayConnection ? 'relay' : 'direct';
    if (transportNow === 'relay') record.usesRelay = true; // sticky; LAN never clears it (section 2.7)
    record.lastTransport = transportNow;
    this.touchThrottled(record.id, transportNow);
    return { ok: true, clientId: record.id, sessionToken: record.id, client: record };
  }

  private touchThrottled(id: string, transportNow: 'relay' | 'direct'): void {
    const previous = this.lastWriteStamp.get(id);
    const stamp = this.now();
    const moved = previous === undefined || previous.transport !== transportNow;
    if (!moved && previous !== undefined && stamp - previous.stamp < LASTUSED_WRITE_THROTTLE_MS) return;
    const record = this.clients.find((client) => client.id === id);
    if (record === undefined) return;
    record.lastUsedAt = new Date(stamp).toISOString();
    this.lastWriteStamp.set(id, { stamp, transport: transportNow });
    this.save();
  }

  revokeClient(id: string): void {
    const record = this.clients.find((client) => client.id === id);
    if (record === undefined || record.revokedAt !== null) return; // idempotent
    record.revokedAt = new Date(this.now()).toISOString();
    this.save();
  }

  purgeRevokedClients(): number {
    const before = this.clients.length;
    this.clients = this.clients.filter((client) => {
      if (client.revokedAt !== null) this.lastWriteStamp.delete(client.id); // no orphaned throttle stamps
      return client.revokedAt === null;
    });
    if (this.clients.length !== before) this.save();
    return before - this.clients.length;
  }

  listClients(): RemoteClientRecord[] {
    return [...this.clients]; // tokenHash: present; plaintext tokens never stored
  }

  hasActiveRelayClients(): boolean {
    return this.clients.some((client) => client.revokedAt === null
      && (client.expiresAt === undefined || Date.parse(client.expiresAt) > this.now())
      && (client.usesRelay === true || client.lastTransport === 'relay')); // observed transport beats the pairing snapshot
  }
}

function resolveLabel(input: CreateClientInput, previous: RemoteClientRecord | undefined): string {
  const explicit = typeof input.label === 'string' && input.label.trim().length > 0 ? input.label.trim() : null;
  if (explicit !== null) return explicit.slice(0, CLIENT_LABEL_MAX);
  const replaced = previous !== undefined && typeof previous.label === 'string' && previous.label.trim().length > 0 ? previous.label.trim() : null;
  if (replaced !== null) return replaced.slice(0, CLIENT_LABEL_MAX); // a rescan without a typed name keeps the operator's name
  const fallback = typeof input.fallbackLabel === 'string' && input.fallbackLabel.trim().length > 0 ? input.fallbackLabel.trim() : 'Remote client';
  return fallback.slice(0, CLIENT_LABEL_MAX);
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Strict-read posture: a foreign/corrupt record (missing tokenHash, junk
 * label, unknown transport) is dropped instead of crashing every later
 * authentication; such records could never authenticate safely anyway. */
function isUsableRecord(value: unknown): value is RemoteClientRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<RemoteClientRecord>;
  return typeof record.id === 'string'
    && typeof record.tokenHash === 'string'
    && typeof record.label === 'string'
    && (record.revokedAt === null || typeof record.revokedAt === 'string')
    && (record.lastTransport === 'relay' || record.lastTransport === 'direct')
    && typeof record.usesRelay === 'boolean';
}

function equalHex(left: string, right: string): boolean {
  try {
    return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
  } catch {
    return false;
  }
}

