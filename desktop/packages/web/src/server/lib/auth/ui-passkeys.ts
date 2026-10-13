// SPDX-License-Identifier: Apache-2.0
/**
 * Passkeys (WebAuthn) server (doc 08 section 2.4): disabled unless a UI
 * password is configured; store `<data-dir>/ui-passkeys.json` bound to the
 * CURRENT password via HMAC(jwtSecret, password) so a password or secret
 * change clears every passkey; rpID derived per request from
 * x-forwarded-host/Host with per-rpID scoping; registration is session-
 * cookie-only, authentication is anonymous and rides the login rate limit;
 * challenges are 5-minute one-shot records whose value is the challenge
 * the ceremony actually returned. The ceremony runs through the
 * WebAuthnCeremony seam (real @simplewebauthn by default) so tests can
 * inject fixtures while production always uses the library.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { deriveRpContext, type RpContext } from './rp-context.ts';
import {
  realCeremony, type AuthenticationResponseJSON, type AuthenticationVerification,
  type CeremonyAdapter, type RegistrationResponseJSON, type RegistrationVerification,
} from './webauthn-ceremony.ts';
import type { UiAuthController } from './ui-auth.ts';

const CHALLENGE_TTL_MS = 5 * 60_000;
const CHALLENGE_BUDGET = 256;
const LABEL_MAX = 80;
/** IANA authenticator transports the L3 registry knows; anything a hostile
 * adapter invents is dropped before it can reach the store. */
const TRANSPORT_TOKENS = new Set(['ble', 'hybrid', 'internal', 'nfc', 'usb']);
const TRANSPORTS_MAX = 8;
/** 43-char base64url == exactly 32 bytes */
const USER_32B_B64URL = /^[A-Za-z0-9_-]{43}$/u;

export interface StoredPasskeyRecord {
  id: string;
  publicKey: string; // base64url
  counter: number;
  transports?: string[];
  deviceType: string;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string;
  label: string;
  rpID: string;
}

interface PasskeyStoreShape {
  version: 1;
  userID: string;
  passwordBinding: string;
  passkeys: StoredPasskeyRecord[];
}

interface ChallengeRecord {
  requestId: string;
  challengeValue: string;
  rpID: string;
  kind: 'register' | 'authenticate';
  expiresAt: number;
}

export const PASSKEYS_DISABLED_TEXT = 'Passkeys require UI password protection to be enabled';

export interface PasskeyAction {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  setCookie?: string;
  clearSessionCookie?: boolean;
}

export interface UiPasskeysOptionsInput {
  dataDir: string;
  uiAuth: UiAuthController;
  now?: () => number;
  ceremony?: CeremonyAdapter;
  rpName?: string;
}

export function createUiPasskeysController(options: UiPasskeysOptionsInput): UiPasskeysController {
  return new UiPasskeysController(options);
}

export class UiPasskeysController {
  private readonly uiAuth: UiAuthController;
  private readonly ceremony: CeremonyAdapter;
  private readonly rpName: string;
  private readonly now: () => number;
  private readonly dataDir: string;
  private userID: string;
  private store: PasskeyStoreShape;
  private readonly challenges = new Map<string, ChallengeRecord>();
  private storeBinding = '';

  constructor(options: UiPasskeysOptionsInput) {
    this.uiAuth = options.uiAuth;
    this.ceremony = options.ceremony ?? realCeremony;
    this.rpName = options.rpName ?? 'NotNativeDesktop';
    this.now = options.now ?? Date.now;
    this.dataDir = options.dataDir;
    const stored = this.readStore();
    this.userID = stored?.userID ?? randomBytes(32).toString('base64url');
    this.store = { version: 1, userID: this.userID, passwordBinding: this.binding(), passkeys: [] };
    if (stored !== null) {
      const sticky = this.binding() !== '' && equalHex(stored.passwordBinding, this.binding());
      this.store.passkeys = sticky ? stored.passkeys.filter(recordIsUsable) : [];
      this.userID = stored.userID;
      this.store.userID = stored.userID;
    }
    this.storeBinding = this.store.passwordBinding;
    this.saveStore(); // binding guard rewrite: mismatches/re-loads rewrite the cleared list
  }

  private path(): string { return joinPath(this.dataDir, 'ui-passkeys.json'); }

  private readStore(): PasskeyStoreShape | null {
    try {
      if (!existsSync(this.path())) return null;
      const raw = JSON.parse(readFileSync(this.path(), 'utf8')) as PasskeyStoreShape | null;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 1
        || typeof raw.userID !== 'string' || typeof raw.passwordBinding !== 'string'
        || !Array.isArray(raw.passkeys)) return null;
      // A corrupted userID would otherwise flow verbatim into registration
      // options bytes; treat the whole store as unusable and regenerate.
      if (!USER_32B_B64URL.test(raw.userID) || Buffer.from(raw.userID, 'base64url').byteLength !== 32) {
        return null;
      }
      return raw;
    } catch {
      return null;
    }
  }

  private binding(): string {
    const password = this.uiAuth.resolvePasswordForBinding();
    if (password === '') return '';
    return createHmac('sha256', this.uiAuth.jwtSecretForBinding()).update(password).digest('hex');
  }

  private password(): string {
    return this.uiAuth.resolvePasswordForBinding();
  }

  hasPassword(): boolean {
    return this.password() !== '';
  }

  private saveStore(): void {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const tmp = `${this.path()}.tmp-${process.pid}-${this.now()}`;
      writeFileSync(tmp, `${JSON.stringify(this.store, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, this.path());
      this.storeBinding = this.store.passwordBinding;
    } catch { /* in-memory truth stands until the next successful save */ }
  }

  /** The store binds to the LIVE password: a changed password/secret clears
   * the list on the next mutation (§2.4). Rewritten empty, never deleted. */
  private ensureFreshBinding(): void {
    const binding = this.binding();
    if (binding !== (this.store.passwordBinding ?? '') && binding !== this.storeBinding) {
      this.store = { version: 1, userID: this.store.userID, passwordBinding: binding, passkeys: [] };
      this.storeBinding = binding;
      this.saveStore();
    }
  }

  /** Auth-reset tail (E-08-3): the reset flow clears passkeys; the rewritten
   * binding recomputes with the rotated secret on the next ensures. */
  resetForAuthReset(): void {
    this.store = { version: 1, userID: this.store.userID, passwordBinding: this.binding(), passkeys: [] };
    this.storeBinding = this.store.passwordBinding;
    this.saveStore();
  }

  private listPasskeys(rpID: string): StoredPasskeyRecord[] {
    this.ensureFreshBinding();
    return this.store.passkeys.filter((record) => record.rpID === rpID);
  }

  disabledAction(): PasskeyAction {
    return { status: 400, body: { error: PASSKEYS_DISABLED_TEXT }, headers: { 'cache-control': 'no-store' } };
  }

  async registerOptions(headers: Headers, url: URL): Promise<PasskeyAction> {
    const rp = deriveRpContext(headers, url);
    if (!this.hasPassword()) return this.disabledAction();
    this.ensureFreshBinding();
    const options = await this.ceremony.registrationOptions({
      rpName: this.rpName,
      rpID: rp.rpID,
      userID: toUint8(Buffer.from(this.store.userID, 'base64url')),
      userName: 'user',
      attestationType: 'none',
      excludeCredentials: this.listPasskeys(rp.rpID).map((record) => ({ id: record.id, transports: record.transports })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    const challenge = challengeFrom(options);
    if (challenge === null) return { status: 500, body: { error: 'Challenge generation failed' }, headers: { 'cache-control': 'no-store' } };
    const record = this.newChallenge('register', rp.rpID, challenge);
    return { status: 200, body: { ...(options as Record<string, unknown>), requestId: record.requestId }, headers: { 'cache-control': 'no-store' } };
  }

  async registerVerify(headers: Headers, url: URL, body: unknown): Promise<PasskeyAction> {
    const rp = deriveRpContext(headers, url);
    if (!this.hasPassword()) return this.disabledAction();
    this.ensureFreshBinding();
    const consumed = this.consumeChallenge(body, 'register', rp.rpID);
    if (typeof consumed !== 'string') return consumed;
    const response = responseRegistrationFrom(body);
    if (response === null) return failAction();
    let outcome: RegistrationVerification;
    try {
      outcome = await this.ceremony.verifyRegistration({
        response,
        expectedChallenge: consumed,
        expectedOrigin: rp.expectedOrigins,
        expectedRPID: rp.rpID,
        requireUserVerification: true,
      });
    } catch {
      return failAction(); // hostile payloads must die as a verification failure, never a 500
    }
    if (outcome.verified !== true) return failAction();
    const info = extractRegistration(outcome);
    if (info === null) return failAction();
    this.store.passkeys = [
      ...this.store.passkeys.filter((record) => !(record.id === info.id && record.rpID === rp.rpID)),
      {
        id: info.id,
        publicKey: Buffer.from(info.publicKey).toString('base64url'),
        counter: info.counter,
        ...(info.transports && info.transports.length > 0 ? { transports: [...info.transports] } : {}),
        deviceType: info.deviceType,
        backedUp: info.backedUp,
        createdAt: new Date(this.now()).toISOString(),
        lastUsedAt: new Date(this.now()).toISOString(),
        label: labelFrom(body),
        rpID: rp.rpID,
      },
    ];
    this.saveStore();
    return { status: 200, body: { verified: true }, headers: { 'cache-control': 'no-store' } };
  }

  async authenticationOptions(headers: Headers, url: URL): Promise<PasskeyAction> {
    const rp = deriveRpContext(headers, url);
    if (!this.hasPassword()) return this.disabledAction();
    this.ensureFreshBinding();
    const existing = this.listPasskeys(rp.rpID);
    if (existing.length === 0) {
      return { status: 400, body: { error: 'No passkeys registered for this origin' }, headers: { 'cache-control': 'no-store' } };
    }
    const options = await this.ceremony.authenticationOptions({
      rpID: rp.rpID,
      allowCredentials: existing.map((record) => ({ id: record.id, transports: record.transports })),
      userVerification: 'required',
    });
    const challenge = challengeFrom(options);
    if (challenge === null) return { status: 500, body: { error: 'Challenge generation failed' }, headers: { 'cache-control': 'no-store' } };
    const record = this.newChallenge('authenticate', rp.rpID, challenge);
    return { status: 200, body: { ...(options as Record<string, unknown>), requestId: record.requestId }, headers: { 'cache-control': 'no-store' } };
  }

  /** Anonymous verify; rides the login rate limit (E-08-21). */
  async authenticateVerify(headers: Headers, url: URL, body: unknown, ip: string): Promise<PasskeyAction> {
    const rp = deriveRpContext(headers, url);
    if (!this.hasPassword()) return this.disabledAction();
    const rate = this.uiAuth.rateAttemptLogin(ip);
    if (!rate.allowed) return { status: 429, body: { error: 'Too many failed login attempts', locked: true }, headers: rate.headers };
    this.ensureFreshBinding();
    const consumed = this.consumeChallenge(body, 'authenticate', rp.rpID);
    if (typeof consumed !== 'string') {
      this.uiAuth.rateRecordLogin(ip);
      return consumed;
    }
    const response = responseAuthenticationFrom(body);
    const record = response === null ? undefined : this.findRecordFor(response.id, rp.rpID);
    if (response === null || record === undefined) {
      this.uiAuth.rateRecordLogin(ip);
      return failAction();
    }
    let outcome: AuthenticationVerification;
    try {
      outcome = await this.ceremony.verifyAuthentication({
        response,
        expectedChallenge: consumed,
        expectedOrigin: rp.expectedOrigins,
        expectedRPID: rp.rpID,
        requireUserVerification: true,
        credential: {
          id: record.id,
          publicKey: toUint8(Buffer.from(record.publicKey, 'base64url')),
          counter: record.counter,
          transports: record.transports,
        },
      });
    } catch {
      this.uiAuth.rateRecordLogin(ip);
      return failAction(); // hostile payloads must die as a verification failure, never a 500
    }
    const counters = outcome.verified === true ? extractAuthentication(outcome) : null;
    if (counters === null || counters.userVerified !== true) {
      this.uiAuth.rateRecordLogin(ip);
      return failAction();
    }
    this.store.passkeys = this.store.passkeys.map((entry) => entry.rpID === rp.rpID && entry.id === record.id
      ? { ...entry, counter: counters.newCounter, lastUsedAt: new Date(this.now()).toISOString() }
      : entry);
    this.saveStore();
    return this.uiAuth.grantedLogin({ ip, headers, url, body });
  }

  listFor(headers: Headers, url: URL): PasskeyAction {
    const rp = deriveRpContext(headers, url);
    if (!this.hasPassword()) return this.disabledAction();
    return { status: 200, body: { passkeys: this.listPasskeys(rp.rpID), rpID: rp.rpID }, headers: { 'cache-control': 'no-store' } };
  }

  /** Revoke matches id AND the current rpID (§2.4). */
  revoke(id: unknown, headers: Headers, url: URL): PasskeyAction {
    const rp = deriveRpContext(headers, url);
    if (!this.hasPassword()) return this.disabledAction();
    this.ensureFreshBinding();
    if (typeof id !== 'string' || id === '') return notFoundAction();
    const before = this.store.passkeys.length;
    this.store.passkeys = this.store.passkeys.filter((record) => !(record.id === id && record.rpID === rp.rpID));
    if (this.store.passkeys.length === before) return notFoundAction();
    this.saveStore();
    return { status: 200, body: { revoked: id }, headers: { 'cache-control': 'no-store' } };
  }

  private findRecordFor(credentialId: unknown, rpID: string): StoredPasskeyRecord | undefined {
    if (typeof credentialId !== 'string' || credentialId === '') return undefined;
    return this.store.passkeys.find((record) => record.id === credentialId && record.rpID === rpID);
  }

  private newChallenge(kind: ChallengeRecord['kind'], rpID: string, challengeValue: string): ChallengeRecord {
    this.pruneChallenges();
    while (this.challenges.size >= CHALLENGE_BUDGET) {
      const oldest = this.challenges.keys().next();
      if (oldest.done) break;
      this.challenges.delete(oldest.value);
    }
    const record: ChallengeRecord = {
      requestId: randomBytes(16).toString('base64url'),
      challengeValue,
      rpID,
      kind,
      expiresAt: this.now() + CHALLENGE_TTL_MS,
    };
    this.challenges.set(record.requestId, record);
    return record;
  }

  /** One-time consumption: shape-invalid requestId / foreign kind / foreign
   * rpID / expired never resolve. */
  private consumeChallenge(body: unknown, kind: ChallengeRecord['kind'], rpID: string): string | PasskeyAction {
    const requestId = (body as { requestId?: unknown } | null)?.requestId;
    if (typeof requestId !== 'string') return failAction();
    const record = this.challenges.get(requestId);
    if (record === undefined || record.expiresAt <= this.now()) return failAction();
    if (record.kind !== kind || record.rpID !== rpID) return failAction();
    this.challenges.delete(requestId);
    return record.challengeValue;
  }

  private pruneChallenges(): void {
    const stamp = this.now();
    for (const [id, record] of this.challenges) {
      if (record.expiresAt <= stamp) this.challenges.delete(id);
    }
  }
}

function toUint8(buffer: Buffer): Uint8Array {
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);
  return copy;
}

function challengeFrom(options: unknown): string | null {
  const value = (options as { challenge?: unknown } | null)?.challenge;
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Runtime shape check first, then the ceremony-specific narrowed type. */
function responseRegistrationFrom(body: unknown): RegistrationResponseJSON | null {
  return responseFrom(body) as RegistrationResponseJSON | null;
}

function responseAuthenticationFrom(body: unknown): AuthenticationResponseJSON | null {
  return responseFrom(body) as AuthenticationResponseJSON | null;
}

function responseFrom(body: unknown): { id: string; rawId: string; type: 'public-key'; response: unknown } | null {
  const response = (body as { response?: unknown } | null)?.response;
  if (typeof response !== 'object' || response === null) return null;
  const candidate = response as { id?: unknown; rawId?: unknown; type?: unknown; response?: unknown };
  if (typeof candidate.id !== 'string' || typeof candidate.rawId !== 'string'
    || candidate.type !== 'public-key' || typeof candidate.response !== 'object') return null;
  return candidate as { id: string; rawId: string; type: 'public-key'; response: unknown };
}

interface RegisterInfo {
  id: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[] | undefined;
  deviceType: string;
  backedUp: boolean;
}

function extractRegistration(outcome: RegistrationVerification): RegisterInfo | null {
  const credential = outcome.registrationInfo?.credential;
  if (credential === undefined || typeof credential.id !== 'string'
    || !(credential.publicKey instanceof Uint8Array) || typeof credential.counter !== 'number') return null;
  return {
    id: credential.id,
    publicKey: new Uint8Array(credential.publicKey),
    counter: credential.counter,
    transports: sanitizedTransports(credential.transports),
    deviceType: String(outcome.registrationInfo?.credentialDeviceType ?? 'singleDevice'),
    backedUp: outcome.registrationInfo?.credentialBackedUp === true,
  };
}

/** Store hygiene: unknown tokens and duplicates are dropped, and the list is
 * capped so a hostile ceremony response cannot bloat the JSON store. */
function sanitizedTransports(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const kept: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const transport = entry.trim().toLowerCase();
    if (!TRANSPORT_TOKENS.has(transport) || kept.includes(transport)) continue;
    kept.push(transport);
    if (kept.length >= TRANSPORTS_MAX) break;
  }
  return kept.length > 0 ? kept : undefined;
}

function extractAuthentication(outcome: AuthenticationVerification): { newCounter: number; userVerified: boolean } | null {
  const info = outcome.authenticationInfo;
  if (info === undefined || typeof info.newCounter !== 'number') return null;
  return { newCounter: info.newCounter, userVerified: info.userVerified === true };
}

function labelFrom(body: unknown): string {
  const label = (body as { label?: unknown } | null)?.label;
  return typeof label === 'string' && label.trim() !== '' ? label.trim().slice(0, LABEL_MAX) : '';
}

function failAction(): PasskeyAction {
  return { status: 400, body: { verified: false, error: 'Passkey verification failed' }, headers: { 'cache-control': 'no-store' } };
}

function notFoundAction(): PasskeyAction {
  return { status: 404, body: { error: 'Passkey not found' }, headers: { 'cache-control': 'no-store' } };
}

function recordIsUsable(value: unknown): value is StoredPasskeyRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<StoredPasskeyRecord>;
  return typeof record.id === 'string' && typeof record.publicKey === 'string'
    && typeof record.rpID === 'string' && record.rpID !== ''
    && typeof record.deviceType === 'string' && typeof record.backedUp === 'boolean'
    && typeof record.label === 'string';
}

function equalHex(left: string, right: string): boolean {
  try {
    return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
  } catch {
    return false;
  }
}

let singleton: UiPasskeysController | null = null;

export function getUiPasskeysController(uiAuthProvider: () => UiAuthController, dataDir?: string): UiPasskeysController {
  if (singleton === null) {
    singleton = createUiPasskeysController({ dataDir: dataDir ?? process.env.NOTNATIVE_DATA_DIR ?? '', uiAuth: uiAuthProvider() });
  }
  return singleton;
}

export function resetPasskeysForTests(): void {
  singleton = null;
}
