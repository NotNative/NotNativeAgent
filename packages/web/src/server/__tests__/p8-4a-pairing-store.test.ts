// SPDX-License-Identifier: Apache-2.0
/**
 * P8-4a gates part 1 (doc 08 section 5.4): the pairing session store —
 * generation formats, the 10 min TTL, one-time secret handling
 * (plaintext only in the create/redeem replies), pending visibility,
 * the single generic redeem error across all failure classes, retry-safe
 * mint failures, sweep retention, lazily persistence across stores.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { sep } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ALLOWED_CLIENT_KINDS, INVALID_PAIRING_SESSION_ERROR, InvalidPairingSessionError, MintFailure,
  PAIRING_TTL_MS, PairingSessionStore, PairingStoreFault, createPairingSessionStore,
  resetPairingSessionStoreForTests, type RedeemPairingInput,
} from '../lib/auth/pairing-sessions.ts';
import type { CreateClientInput, CreatedClient } from '../lib/auth/remote-clients.ts';
import { ENV } from '../env.ts';

const isolatedDataDir = mkdtempSync(`${tmpdir()}${sep}nnd-p84-store-`);
process.env.NOTNATIVE_DATA_DIR = isolatedDataDir;
delete process.env.NOTNATIVE_UI_PASSWORD;
const scratch: string[] = [];
let clock = 1_000_000_000_000;
const now = (): number => clock;

afterAll(() => {
  resetPairingSessionStoreForTests();
  rmSync(isolatedDataDir, { recursive: true, force: true });
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  scratch.length = 0;
  minted.length = 0;
  clock = 1_000_000_000_000;
});

function freshDir(): string {
  const made = mkdtempSync(`${tmpdir()}${sep}nnd-p84-`);
  scratch.push(made);
  return made;
}

function freshStore(): PairingSessionStore {
  return createPairingSessionStore({ dataDir: freshDir(), now, mintClient: recordMint });
}

interface MintCapture { input: CreateClientInput; created: CreatedClient }
const minted: MintCapture[] = [];

function recordMint(input: CreateClientInput): CreatedClient {
  const created: CreatedClient = {
    client: {
      id: `dev_${minted.length + 1}`,
      label: input.label ?? input.fallbackLabel ?? 'Remote client',
      createdAt: new Date(clock).toISOString(),
      lastUsedAt: new Date(clock).toISOString(),
      revokedAt: null,
      tokenHash: 'hash-precomputed-by-mint',
      clientKind: input.clientKind ?? 'mobile',
      usesRelay: input.usesRelay === true,
      lastTransport: 'direct',
      ...(input.authMethod !== undefined ? { authMethod: input.authMethod } : {}),
      ...(input.pairingId !== undefined ? { pairingId: input.pairingId } : {}),
      ...(input.dedupeKey !== undefined ? { dedupeKey: input.dedupeKey } : {}),
      ...(input.deviceName !== undefined ? { deviceName: input.deviceName } : {}),
      ...(input.devicePlatform !== undefined ? { devicePlatform: input.devicePlatform } : {}),
      ...(input.deviceModel !== undefined ? { deviceModel: input.deviceModel } : {}),
      ...(input.appVersion !== undefined ? { appVersion: input.appVersion } : {}),
    },
    token: `oc_client_${minted.length + 1}`,
  };
  minted.push({ input, created } satisfies MintCapture);
  return created;
}

function failingMint(): CreatedClient {
  throw new Error('wallet exploded');
}

function lastMint(): MintCapture {
  const last = minted[minted.length - 1];
  if (last === undefined) throw new Error('no mint recorded');
  return last;
}

describe('pairing session store', () => {
  it('constructs with the ENV boot default when NOTNATIVE_DATA_DIR is unset (review P0)', () => {
    const saved = process.env.NOTNATIVE_DATA_DIR;
    delete process.env.NOTNATIVE_DATA_DIR;
    try {
      const store = createPairingSessionStore({ now, mintClient: recordMint });
      const internal = store as unknown as { dataDir: string };
      expect(internal.dataDir).toBe(ENV.dataDir);
      expect(internal.dataDir).not.toBe('');
    } finally {
      process.env.NOTNATIVE_DATA_DIR = saved;
    }
  });

  it('a store-write failure after minting rewinds the stamp and throws PairingStoreFault (retry-safe)', () => {
    const store = freshStore();
    const session = store.createPairingSession({});
    const internal = store as unknown as { save(): void };
    let failing = true;
    const saveSpy = vi.spyOn(internal, 'save').mockImplementation(() => {
      if (failing) throw new Error('disk on fire');
    });
    expect(() => store.redeemPairingSession({ pairingId: session.id, secret: session.secret }, recordMint)).toThrow(PairingStoreFault);
    expect(store.findSession(session.id)?.usedAt).toBeNull(); // stamp rewound: still redeemable
    failing = false;
    const outcome = store.redeemPairingSession({ pairingId: session.id, secret: session.secret }, recordMint);
    expect(outcome.token).toMatch(/^oc_client_/u); // retry after the fault succeeds
    expect(saveSpy).toHaveBeenCalled();
  });
  it('creates a one-time session with exact generation formats and the 10 min TTL', () => {
    const store = freshStore();
    const created = store.createPairingSession({ label: 'atlas-phone', allowedClientKinds: ['mobile'] });
    expect(created.id).toMatch(/^pair_[0-9a-f]{24}$/u);
    expect(created.secret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(created.fingerprint).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/u);
    expect(Date.parse(created.expiresAt) - Date.parse(created.createdAt)).toBe(PAIRING_TTL_MS);
    expect(created.clientId).toBeNull();
    expect(created.createdByClientId).toBeNull();
    expect(created.usesRelay).toBe(false);
    expect(created.label).toBe('atlas-phone');
  });

  it('persists a sha256 secretHash in the store file and never the plaintext', () => {
    const dir = freshDir();
    const store = createPairingSessionStore({ dataDir: dir, now });
    const created = store.createPairingSession({});
    const disk = JSON.parse(readFileSync(`${dir}/client-pairing-sessions.json`, 'utf8')) as { version: number; sessions: Array<{ secretHash: string; id: string; allowedClientKinds: string[] }> };
    expect(disk.version).toBe(1);
    const row = disk.sessions.find((entry) => entry.id === created.id);
    expect(row?.secretHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(disk)).not.toContain(created.secret);
    expect(row?.allowedClientKinds).toEqual([...DEFAULT_ALLOWED_CLIENT_KINDS]);
  });

  it('lists pending sessions without secrets and without the hash', () => {
    const store = freshStore();
    const a = store.createPairingSession({ label: 'a' });
    const b = store.createPairingSession({ label: 'b', createdByClientId: 'dev_admin' });
    const pending = store.listPendingSessions();
    expect(pending.map((session) => session.id)).toContain(a.id);
    expect(pending.map((session) => session.id)).toContain(b.id);
    for (const session of pending) {
      expect(Object.keys(session)).not.toContain('secretHash');
      expect(Object.keys(session)).not.toContain('secret');
    }
    expect(pending.find((session) => session.id === b.id)?.createdByClientId).toBe('dev_admin');
  });

  it('pending excludes used, cancelled, expired; auditable retention keeps abandoned rows findable', () => {
    const store = freshStore();
    const expired = store.createPairingSession({});
    const cancelled = store.createPairingSession({});
    const used = store.createPairingSession({});
    store.cancelPairingSession(cancelled.id);
    store.redeemPairingSession({ pairingId: used.id, secret: used.secret }, recordMint);
    clock += PAIRING_TTL_MS + 1;
    store.createPairingSession({}); // mutation triggers the sweeper
    const pending = store.listPendingSessions().map((session) => session.id);
    expect(pending).not.toContain(expired.id);
    expect(pending).not.toContain(cancelled.id);
    expect(pending).not.toContain(used.id);
    expect(store.findSession(expired.id)).toBeUndefined(); // unredeemed dropped once expired
    expect(store.findSession(cancelled.id)?.cancelledAt).not.toBeNull(); // retained until inactive+TTL
    expect(store.findSession(used.id)?.usedAt).not.toBeNull();
  });

  it('relay demand signal tracks still-redeemable relay sessions only', () => {
    const store = freshStore();
    expect(store.hasActiveRelaySession()).toBe(false);
    const plain = store.createPairingSession({ usesRelay: false });
    expect(store.hasActiveRelaySession()).toBe(false);
    const relay = store.createPairingSession({ usesRelay: true });
    expect(store.hasActiveRelaySession()).toBe(true);
    store.cancelPairingSession(relay.id);
    expect(store.hasActiveRelaySession()).toBe(false);
    const relay2 = store.createPairingSession({ usesRelay: true });
    const outcome = store.redeemPairingSession({ pairingId: relay2.id, secret: relay2.secret, clientLabel: 'tab' }, recordMint);
    expect(outcome.token).toMatch(/^oc_client_/u);
    expect(store.hasActiveRelaySession()).toBe(false); // redeemed row is no longer pending (the DEVICE carries demand)
    store.cancelPairingSession(plain.id);
  });

  it('cancel stamps once and answers cancelled:false for unknown or already-gone ids', () => {
    const store = freshStore();
    const created = store.createPairingSession({});
    expect(store.cancelPairingSession(created.id).cancelled).toBe(true);
    expect(store.cancelPairingSession(created.id).cancelled).toBe(false);
    expect(store.cancelPairingSession('pair_ffffffffffffffffffffffff').cancelled).toBe(false);
    expect(store.cancelPairingSession('pair_ffffffffffffffffffffffff').pairing).toBeNull();
  });

  it('redeem fails with the ONE generic error for every failure class', () => {
    const store = freshStore();
    const live = store.createPairingSession({ allowedClientKinds: ['mobile'] });
    const cancelled = store.createPairingSession({});
    store.cancelPairingSession(cancelled.id);
    const used = store.createPairingSession({});
    store.redeemPairingSession({ pairingId: used.id, secret: used.secret }, recordMint);
    const expired = store.createPairingSession({});
    clock = Date.parse(expired.expiresAt) + 1;
    const cases: Array<Record<string, unknown>> = [
      { pairingId: '', secret: '' },
      { pairingId: live.id, secret: '' },
      { pairingId: 'pair_000000000000000000000000', secret: 'x' },
      { pairingId: cancelled.id, secret: cancelled.secret },
      { pairingId: used.id, secret: used.secret },
      { pairingId: expired.id, secret: expired.secret },
      { pairingId: live.id, secret: 'the-wrong-secret' },
      { pairingId: live.id, secret: live.secret, clientKind: 'desktop' },
    ];
    for (const attempt of cases) {
      try {
        store.redeemPairingSession(attempt as unknown as RedeemPairingInput, recordMint);
        expect.unreachable('redeem should have thrown');
      } catch (error) {
        expect((error as Error).message).toBe(INVALID_PAIRING_SESSION_ERROR);
      }
    }
  });

  it('redeem mints with pairing metadata and stamps usedAt + clientId', () => {
    const store = freshStore();
    const session = store.createPairingSession({ label: 'nna-phone', allowedClientKinds: ['mobile', 'desktop'], usesRelay: true });
    const outcome = store.redeemPairingSession({
      pairingId: session.id,
      secret: session.secret,
      clientLabel: 'Joshua iPhone',
      clientKind: 'desktop',
      deviceName: 'Joshua iPhone',
      devicePlatform: 'ios',
      deviceModel: 'iPhone 16',
      appVersion: '2.9.1',
    }, recordMint);
    const mint = lastMint();
    expect(mint.input['authMethod']).toBe('pairing');
    expect(mint.input['pairingId']).toBe(session.id);
    expect(mint.input['dedupeKey']).toBe(`pairing:${session.id}`);
    expect(mint.input['label']).toBe('nna-phone');
    expect(mint.input['clientKind']).toBe('desktop');
    expect(mint.input['usesRelay']).toBe(true);
    expect(mint.input['devicePlatform']).toBe('ios');
    expect(mint.input['deviceModel']).toBe('iPhone 16');
    expect(mint.input['appVersion']).toBe('2.9.1');
    expect(outcome.token).toMatch(/^oc_client_/u);
    expect(outcome.pairing.usedAt).not.toBeNull();
    expect(outcome.pairing.clientId).toBe(outcome.client.id);
    expect(store.findSession(session.id)?.usedAt).not.toBeNull();
  });

  it('redeem label precedence: session label wins; else device self-report; else Remote client', () => {
    const store = freshStore();
    const explicit = store.createPairingSession({ label: 'desk setup' });
    store.redeemPairingSession({ pairingId: explicit.id, secret: explicit.secret, clientLabel: 'typed elsewhere' }, recordMint);
    expect(lastMint().input['label']).toBe('desk setup');

    const unlabeled = store.createPairingSession({});
    store.redeemPairingSession({ pairingId: unlabeled.id, secret: unlabeled.secret, clientLabel: 'Pixel 9' }, recordMint);
    expect(lastMint().input['label']).toBeUndefined();
    expect(lastMint().input['fallbackLabel']).toBe('Pixel 9');

    const unlabeled2 = store.createPairingSession({});
    store.redeemPairingSession({ pairingId: unlabeled2.id, secret: unlabeled2.secret, deviceName: 'Rog Phone' }, recordMint);
    expect(lastMint().input['fallbackLabel']).toBe('Rog Phone');

    const unlabeled3 = store.createPairingSession({});
    store.redeemPairingSession({ pairingId: unlabeled3.id, secret: unlabeled3.secret }, recordMint);
    expect(lastMint().input['fallbackLabel']).toBe('Remote client');
  });

  it('a thrown mint leaves the session redeemable (retry-safe) and surfaces MintFailure', () => {
    const store = freshStore();
    const session = store.createPairingSession({});
    expect(() => store.redeemPairingSession({ pairingId: session.id, secret: session.secret }, failingMint)).toThrow(MintFailure);
    expect(store.findSession(session.id)?.usedAt).toBeNull();
    const outcome = store.redeemPairingSession({ pairingId: session.id, secret: session.secret }, recordMint);
    expect(outcome.token).toMatch(/^oc_client_/u);
    expect(store.findSession(session.id)?.usedAt).not.toBeNull();
  });

  it('custom dedupeKey reaches the mint; unknown kind lists fall back to defaults; kind scoped lists enforce', () => {
    const store = freshStore();
    const fallback = store.createPairingSession({ allowedClientKinds: ['not-a-kind', 'desktop'] });
    expect(fallback.allowedClientKinds).toEqual(['desktop']); // unknown kinds drop, known survive
    const junkOnly = store.createPairingSession({ allowedClientKinds: ['not-a-kind'] });
    expect(junkOnly.allowedClientKinds).toEqual([...DEFAULT_ALLOWED_CLIENT_KINDS]); // empty pick -> dialog defaults
    store.redeemPairingSession({ pairingId: fallback.id, secret: fallback.secret, clientKind: 'desktop', dedupeKey: 'mobile:abc' }, recordMint);
    expect(lastMint().input['dedupeKey']).toBe('mobile:abc');
    expect(lastMint().input['clientKind']).toBe('desktop');
    store.redeemPairingSession({ pairingId: junkOnly.id, secret: junkOnly.secret }, recordMint); // no kind -> mobile
    expect(lastMint().input['clientKind']).toBe('mobile');

    const scoped = store.createPairingSession({ allowedClientKinds: ['desktop'] });
    expect(scoped.allowedClientKinds).toEqual(['desktop']);
    store.redeemPairingSession({ pairingId: scoped.id, secret: scoped.secret, clientKind: 'desktop' }, recordMint);
    expect(lastMint().input['clientKind']).toBe('desktop');
  });

  it('sweeps expired unredeemed rows on the next mutation; retained rows drop after inactive+TTL', () => {
    const store = freshStore();
    const shortLived = store.createPairingSession({});
    clock += PAIRING_TTL_MS + 1;
    store.createPairingSession({});
    expect(store.findSession(shortLived.id)).toBeUndefined();
    const cancelled = store.createPairingSession({});
    store.cancelPairingSession(cancelled.id);
    const cancelledAt = Date.parse(store.findSession(cancelled.id)!.cancelledAt!);
    clock = cancelledAt + PAIRING_TTL_MS + 1;
    store.createPairingSession({});
    expect(store.findSession(cancelled.id)).toBeUndefined();
  });

  it('cancel answers cancelled:false for a USED session (nothing left to revoke, E-08-33g)', () => {
    const store = freshStore();
    const used = store.createPairingSession({});
    store.redeemPairingSession({ pairingId: used.id, secret: used.secret }, recordMint);
    const outcome = store.cancelPairingSession(used.id);
    expect(outcome.cancelled).toBe(false);
    expect(store.findSession(used.id)?.cancelledAt).toBeNull();
    expect(store.findSession(used.id)?.usedAt).not.toBeNull(); // the redeem stamp is the audit anchor
  });

  it('redeem auth-class failures are typed InvalidPairingSessionError with the contract string', () => {
    const store = freshStore();
    expect(() => store.redeemPairingSession({ pairingId: 'pair_000000000000000000000000', secret: 'x' }, recordMint)).toThrow(InvalidPairingSessionError);
    let thrown: unknown;
    try {
      store.redeemPairingSession({ pairingId: 'pair_000000000000000000000000', secret: 'x' }, recordMint);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toBe(INVALID_PAIRING_SESSION_ERROR);
    expect((thrown as InvalidPairingSessionError).name).toBe('InvalidPairingSessionError');
  });

  it('labels clamp to 80 chars on create (260-char input survives trimmed)', () => {
    const store = freshStore();
    const created = store.createPairingSession({ label: 'x'.repeat(260) });
    expect(created.label).toHaveLength(80);
  });

  it('sessions reload from disk for a second store; the consumed stamp blocks re-redeem', () => {
    const dir = freshDir();
    const first = createPairingSessionStore({ dataDir: dir, now });
    const created = first.createPairingSession({ label: 'persisted' });
    const second = createPairingSessionStore({ dataDir: dir, now });
    expect(second.listPendingSessions().map((session) => session.id)).toContain(created.id);
    const consumed = second.redeemPairingSession({ pairingId: created.id, secret: created.secret }, recordMint);
    expect(consumed.token).toMatch(/^oc_client_/u);
    const reloaded = createPairingSessionStore({ dataDir: dir, now });
    const view = reloaded.findSession(created.id);
    expect(view?.usedAt).not.toBeNull();
    expect(view?.clientId).toBe(consumed.client.id);
    expect(() => reloaded.redeemPairingSession({ pairingId: created.id, secret: created.secret }, recordMint)).toThrow(INVALID_PAIRING_SESSION_ERROR);
  });

  it('a corrupt store file degrades to no-known-sessions and keeps working', () => {
    const dir = freshDir();
    writeFileSync(`${dir}/client-pairing-sessions.json`, '{not json', 'utf8');
    const store = createPairingSessionStore({ dataDir: dir, now });
    expect(store.listPendingSessions()).toEqual([]);
    const created = store.createPairingSession({});
    expect(store.findSession(created.id)?.id).toBe(created.id);
  });

  it('redeems with padded id/secret (normalized per section 5.4 step 1)', () => {
    const store = freshStore();
    const session = store.createPairingSession({});
    const outcome = store.redeemPairingSession({ pairingId: ` ${session.id} `, secret: ` ${session.secret} ` }, recordMint);
    expect(outcome.token).toMatch(/^oc_client_/u);
  });
});
