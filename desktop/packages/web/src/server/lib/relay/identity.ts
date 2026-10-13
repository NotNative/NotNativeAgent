// SPDX-License-Identifier: Apache-2.0
/**
 * Relay host identity (doc 08 section 3.2): long-lived ECDSA P-256
 * signing keypair + ECDH P-256 encryption keypair held in a dedicated
 * atomic dataDir store. `serverId` = base64url(sha256(JSON of
 * {crv,kty,x,y})) is the routing key at the relay worker. Host->worker
 * auth signs `${ts}.${serverId}.${role}.${connectionId ?? ''}` with
 * ECDSA-SHA256 (IEEE P1363 raw r||s) per WebSocket URL. The regeneration
 * gate is strict: a CORRUPT store never regenerates (a new key means a
 * new serverId and orphans every paired device) — only true absence
 * mints keys. E-08-23: the NND keys live in a dedicated file instead of
 * the settings registry until the registry gains relay keys (machine-
 * managed secrets; the push-relay sharing lands with the push slice).
 */
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { webcrypto } from 'node:crypto';
import { ENV } from '../../env.ts';

export type RelayRole = 'host-control' | 'host-data' | 'client';
export const RELAY_APP_ID = 'openchamber';

export interface RelayJwk {
  kty: string;
  crv: string;
  x: string;
  y: string;
  d?: string;
}

export interface RelayIdentity {
  signing: { privateJwk: RelayJwk; publicJwk: RelayJwk };
  encryption: { privateJwk: RelayJwk; publicJwk: RelayJwk };
}

interface IdentityStoreShape {
  version: 1;
  signing: { privateJwk: RelayJwk; publicJwk: RelayJwk };
  encryption: { privateJwk: RelayJwk; publicJwk: RelayJwk };
}

type ReadState = { state: 'absent' } | { state: 'ok'; value: IdentityStoreShape } | { state: 'corrupt' };

function isRelayJwk(value: unknown): value is RelayJwk {
  if (typeof value !== 'object' || value === null) return false;
  const jwk = value as Partial<RelayJwk>;
  return jwk.kty === 'EC' && jwk.crv === 'P-256'
    && typeof jwk.x === 'string' && jwk.x.length > 0
    && typeof jwk.y === 'string' && jwk.y.length > 0;
}

function isEcPrivateJwk(value: unknown): value is RelayJwk {
  return isRelayJwk(value) && typeof (value as Partial<RelayJwk>).d === 'string'
    && (value as RelayJwk).d !== '';
}

/** Canonical public JWK: only {crv,kty,x,y}, exactly that key order. */
export function publicJwkCanonical(jwk: RelayJwk): RelayJwk {
  return { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
}

/** serverId (doc 08 section 3.2): base64url(sha256(canonical public JWK JSON)). */
export function serverIdFromJwk(publicJwk: RelayJwk): string {
  return createHash('sha256')
    .update(JSON.stringify(publicJwkCanonical(publicJwk)))
    .digest('base64url');
}

export function publicKeyJwkFingerprint(publicJwk: RelayJwk): string {
  return JSON.stringify(publicJwkCanonical(publicJwk));
}

export async function generateSigningIdentity(): Promise<{ privateJwk: RelayJwk; publicJwk: RelayJwk }> {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  );
  const privateJwk = await webcrypto.subtle.exportKey('jwk', pair.privateKey) as RelayJwk;
  const publicJwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey) as RelayJwk;
  if (!isEcPrivateJwk(privateJwk) || !isRelayJwk(publicJwk)) {
    throw new Error('signing key generation produced unusable JWKs');
  }
  return {
    privateJwk: { kty: privateJwk.kty, crv: privateJwk.crv, x: privateJwk.x, y: privateJwk.y, d: privateJwk.d },
    publicJwk: publicJwkCanonical(publicJwk),
  };
}

export async function generateEncryptionIdentity(): Promise<{ privateJwk: RelayJwk; publicJwk: RelayJwk }> {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  );
  const privateJwk = await webcrypto.subtle.exportKey('jwk', pair.privateKey) as RelayJwk;
  const publicJwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey) as RelayJwk;
  if (!isEcPrivateJwk(privateJwk) || !isRelayJwk(publicJwk)) {
    throw new Error('encryption key generation produced unusable JWKs');
  }
  return {
    privateJwk: { kty: privateJwk.kty, crv: privateJwk.crv, x: privateJwk.x, y: privateJwk.y, d: privateJwk.d },
    publicJwk: publicJwkCanonical(publicJwk),
  };
}

function readIdentityFile(path: string): ReadState {
  try {
    if (!existsSync(path)) return { state: 'absent' };
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<IdentityStoreShape> | null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.version !== 1) {
      return { state: 'corrupt' };
    }
    const signing = parsed.signing as IdentityStoreShape['signing'] | undefined;
    const encryption = parsed.encryption as IdentityStoreShape['encryption'] | undefined;
    if (typeof signing !== 'object' || signing === undefined || typeof encryption !== 'object' || encryption === undefined) {
      return { state: 'corrupt' };
    }
    if (!isEcPrivateJwk(signing.privateJwk) || !isRelayJwk(signing.publicJwk)) return { state: 'corrupt' };
    if (!isEcPrivateJwk(encryption.privateJwk) || !isRelayJwk(encryption.publicJwk)) return { state: 'corrupt' };
    return { state: 'ok', value: { version: 1, signing, encryption } };
  } catch {
    return { state: 'corrupt' };
  }
}

function writeIdentityFile(path: string, value: IdentityStoreShape, dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export class RelayIdentityStore {
  private identity: RelayIdentity | null = null;
  private inflight: Promise<RelayIdentity> | null = null;
  private readonly dataDir: string;
  private readonly path: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.path = joinPath(dataDir, 'relay-identity.json');
  }

  /** Strict: corrupt presence throws (never silently regenerates); only
   * true absence mints keys. A regeneration would orphan every paired
   * device (new serverId) and the push binding. Concurrent resolve()
   * single-mints process-wide (the in-flight promise is shared). Across
   * processes a simultaneous mint is last-writer-wins: each process
   * adopts whichever self-consistent file the round-trip verify read. */
  async resolve(): Promise<RelayIdentity> {
    if (this.identity !== null) return this.identity;
    if (this.inflight !== null) return await this.inflight;
    const read = readIdentityFile(this.path);
    if (read.state === 'corrupt') {
      throw new Error(`relay identity store is corrupt and must NOT regenerate: ${this.path}`);
    }
    if (read.state === 'ok') {
      this.identity = { signing: read.value.signing, encryption: read.value.encryption };
      return this.identity;
    }
    const mint = this.mintAndPersist();
    this.inflight = mint.finally(() => { this.inflight = null; });
    return await this.inflight;
  }

  private async mintAndPersist(): Promise<RelayIdentity> {
    const signing = await generateSigningIdentity();
    const encryption = await generateEncryptionIdentity();
    writeIdentityFile(this.path, { version: 1, signing, encryption }, this.dataDir);
    const verify = readIdentityFile(this.path);
    if (verify.state !== 'ok') throw new Error('relay identity write did not round-trip');
    this.identity = { signing: verify.value.signing, encryption: verify.value.encryption };
    return this.identity;
  }

  async serverId(): Promise<string> {
    return serverIdFromJwk((await this.resolve()).signing.publicJwk);
  }

  /** Per-WebSocket-URL auth (doc 08 sections 3.2/3.3): the signed payload
   * is `${ts}.${serverId}.${role}.${connectionId ?? ''}`; the URL carries
   * ts (epoch ms), sig (base64url IEEE P1363 r||s), pk (base64url of the
   * canonical public JWK string). The worker binds the socket to serverId
   * after verifying sig against pk. The CALLER mints a fresh ts
   * immediately at socket open — the worker rejects stale ts values
   * (doc 08 section 3.2), so `ts` is recorded on the wire only briefly. */
  async authParams(role: RelayRole, ts: number, connectionId?: string): Promise<{ serverId: string; ts: number; sig: string; pk: string }> {
    const identity = await this.resolve();
    const serverId = serverIdFromJwk(identity.signing.publicJwk);
    const payload = `${ts}.${serverId}.${role}.${connectionId ?? ''}`;
    const key = createPrivateKey({ key: identity.signing.privateJwk as never, format: 'jwk' });
    const signature = sign('SHA256', Buffer.from(payload, 'utf8'), {
      key,
      dsaEncoding: 'ieee-p1363',
    });
    return {
      serverId,
      ts,
      sig: Buffer.from(signature).toString('base64url'),
      pk: Buffer.from(JSON.stringify(publicJwkCanonical(identity.signing.publicJwk)), 'utf8').toString('base64url'),
    };
  }

  /** WS URL builder (doc 08 section 3.3). WHATWG URL parses ws/wss
   * authorities directly; scheme survives untouched. */
  async relaySocketUrl(base_url: string, role: RelayRole, ts: number, extra: { connectionId?: string; grant?: string; appId?: string; appVersion?: string; platform?: string } = {}): Promise<string> {
    const auth = await this.authParams(role, ts, extra.connectionId);
    const parsed = new URL(base_url);
    parsed.searchParams.set('v', '1');
    parsed.searchParams.set('role', role);
    parsed.searchParams.set('serverId', auth.serverId);
    parsed.searchParams.set('appId', extra.appId ?? RELAY_APP_ID);
    if (extra.appVersion !== undefined) parsed.searchParams.set('appVersion', extra.appVersion);
    if (extra.platform !== undefined) parsed.searchParams.set('platform', extra.platform);
    if (extra.grant !== undefined) parsed.searchParams.set('grant', extra.grant);
    if (extra.connectionId !== undefined) parsed.searchParams.set('connectionId', extra.connectionId);
    parsed.searchParams.set('ts', String(auth.ts));
    parsed.searchParams.set('sig', auth.sig);
    parsed.searchParams.set('pk', auth.pk);
    return parsed.toString();
  }
}

// ---- process-wide shared store (server boot + /health speak the SAME
// identity; no parallel stores may mint different serverIds) ------------------

interface SharedStorePlace {
  dataDir: string;
  store: RelayIdentityStore;
}

let sharedPlace: SharedStorePlace | null = null;

/** The process-wide relay identity store (E-08-25c: mint once at boot —
 * every consumer shares one store; a dataDir change rebinds so test
 * suites with fresh temp dirs never resurrect another suite's files). */
export function getSharedRelayIdentityStore(dataDir?: string): RelayIdentityStore {
  const dir = dataDir ?? ENV.dataDir;
  if (sharedPlace === null || sharedPlace.dataDir !== dir) {
    sharedPlace = { dataDir: dir, store: new RelayIdentityStore(dir) };
  }
  return sharedPlace.store;
}

/** Fail-soft /health peek (E-08-2): resolves or mints the shared identity
 * and answers its serverId; any failure (corrupt store gate) answers null
 * and /health never 500s on relay identity trouble. */
export async function peekRelayServerId(): Promise<string | null> {
  try {
    return await getSharedRelayIdentityStore().serverId();
  } catch {
    return null;
  }
}

/** Test seam: forgets the shared store instance (fresh dataDir per suite). */
export function resetSharedRelayIdentityForTests(): void {
  sharedPlace = null;
}
