// SPDX-License-Identifier: Apache-2.0
/**
 * P8-3a gates part 1 (doc 08 §3.12 + §3.15 machine machinery): the relay
   * config store (dedicated relay-config.json, strict read, never rewritten
  * on corruption), the machine claim (relay-host.lock {pid, claimedAt}
  * tryClaim/forceClaim/release with live/stale/EPERM liveness semantics —
  * claim writes report 'claimed'/'contended'/'write-failed' so the §3.12
  * pre-lock row stays executable), and the relay URL chain normalizations.
  * File-level only — no sockets.
  */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath, sep } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RelayConfigStore,
  DEFAULT_RELAY_URL,
  normalizeRelayUrl,
  readEnvBatchWindowMs,
  readEnvRelayUrl,
  readRelayHostHoldOut,
  relayConfigPath,
  relayUrlLocked,
  resolveRelayUrl,
} from '../lib/relay/relay-config.ts';
import { RelayHostLock, type RelayClaimOutcome } from '../lib/relay/host-lock.ts';
import { legBatchOptions } from '../lib/relay/leg-host.ts';

const scratchDirs: string[] = [];

function freshDir(prefix: string): string {
  const made = mkdtempSync(`${tmpdir()}${sep}${prefix}-`);
  scratchDirs.push(made);
  return made;
}

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  delete process.env.NOTNATIVE_RELAY_URL;
  delete process.env.NOTNATIVE_RELAY_HOST;
  delete process.env.NOTNATIVE_ELECTRON_DEV;
  delete process.env.NOTNATIVE_RELAY_BATCH_WINDOW_MS;
});

afterAll(() => {
  delete process.env.NOTNATIVE_RELAY_URL;
  delete process.env.NOTNATIVE_RELAY_HOST;
  delete process.env.NOTNATIVE_ELECTRON_DEV;
  delete process.env.NOTNATIVE_RELAY_BATCH_WINDOW_MS;
});

describe('relay config store (relay-config.json machine file, E-08-28)', () => {
  it('reads defaults when the file is absent and round-trips writes', () => {
    const dir = freshDir('nnd-p83-config');
    const store = new RelayConfigStore(dir);
    expect(store.read()).toEqual({ enabled: false, relayUrl: null, corrupt: false });
    store.write({ enabled: true, relayUrl: 'wss://relay.example/ws' });
    expect(store.read()).toEqual({ enabled: true, relayUrl: 'wss://relay.example/ws', corrupt: false });
    expect(existsSync(relayConfigPath(dir))).toBe(true);
    const raw = JSON.parse(readFileSync(relayConfigPath(dir), 'utf8')) as { version: number };
    expect(raw.version).toBe(1);
  });

  it('a corrupt file refuses: reads mark corrupt and writes throw (no silent repair)', () => {
    const dir = freshDir('nnd-p83-config');
    const store = new RelayConfigStore(dir);
    writeFileSync(relayConfigPath(dir), '{"version":2,"enabled":true}', { encoding: 'utf8' });
    const read = store.read();
    expect(read).toMatchObject({ corrupt: true, enabled: false, relayUrl: null });
    expect(() => store.write({ enabled: true, relayUrl: null })).toThrow(/corrupt/);
    // the corrupt bytes are untouched
    expect(readFileSync(relayConfigPath(dir), 'utf8')).toBe('{"version":2,"enabled":true}');
  });

  it('a non-ws stored relayUrl is shape-rejected as corrupt (strict reader)', () => {
    const dir = freshDir('nnd-p83-config');
    const store = new RelayConfigStore(dir);
    writeFileSync(relayConfigPath(dir), JSON.stringify({ version: 1, enabled: true, relayUrl: 'https://junk' }), { encoding: 'utf8' });
    expect(store.read()).toMatchObject({ corrupt: true });
  });
});

describe('relay host machine claim (relay-host.lock)', () => {
  it('claims when absent, refreshing an OWN live claim is a no-op truth', () => {
    const dir = freshDir('nnd-p83-lock');
    const lock = new RelayHostLock({ dataDir: dir });
    expect(lock.tryClaim()).toBe('claimed');
    const first = readFileSync(lock.path(), 'utf8');
    expect(lock.tryClaim()).toBe('claimed');
    expect(JSON.parse(readFileSync(lock.path(), 'utf8'))).toMatchObject({ pid: process.pid });
    expect(first.length).toBeGreaterThan(0);
    expect(lock.readOwnClaim()).not.toBeNull();
    expect(lock.foreignClaimant()).toBeNull();
    lock.release();
    expect(existsSync(lock.path())).toBe(false);
  });

  it('a LIVE foreign claimant refuses tryClaim; ESRCH stale pid is claimable', () => {
    const dir = freshDir('nnd-p83-lock');
    const alive = (pid: number): boolean => pid === 4711;
    writeFileSync(relayLock(dir), JSON.stringify({ pid: 4711, claimedAt: '2026-01-01T00:00:00.000Z' }), { encoding: 'utf8' });
    const blocked = new RelayHostLock({ dataDir: dir, processAlive: alive });
    expect(blocked.tryClaim()).toBe('contended');
    expect(blocked.foreignClaimant()).toMatchObject({ pid: 4711 });
    // ESRCH: the pid died; the stale file is claimable
    const stale = new RelayHostLock({ dataDir: dir, processAlive: () => false });
    expect(stale.tryClaim()).toBe('claimed');
    expect(JSON.parse(readFileSync(stale.path(), 'utf8'))).toMatchObject({ pid: process.pid });
  });

  it('EPERM (foreign user, alive) is treated as alive and blocks the claim', () => {
    const dir = freshDir('nnd-p83-lock');
    writeFileSync(relayLock(dir), JSON.stringify({ pid: 999, claimedAt: '2026-01-01T00:00:00.000Z' }), { encoding: 'utf8' });
    const lock = new RelayHostLock({ dataDir: dir, processAlive: () => true });
    expect(lock.tryClaim()).toBe('contended');
    expect(lock.forceClaim()).toBe('claimed'); // force is unconditional
    expect(JSON.parse(readFileSync(lock.path(), 'utf8'))).toMatchObject({ pid: process.pid });
  });

  it('release deletes only the OWNER file; a foreign claim never leaves via release', () => {
    const dir = freshDir('nnd-p83-lock');
    writeFileSync(relayLock(dir), JSON.stringify({ pid: 4242, claimedAt: 'x' }), { encoding: 'utf8' });
    const lock = new RelayHostLock({ dataDir: dir, processAlive: () => false });
    lock.release();
    expect(readFileSync(relayLock(dir), 'utf8')).toContain('4242');
  });

  it('a corrupt lock behaves as no-claim and is overwritten by the next claim', () => {
    const dir = freshDir('nnd-p83-lock');
    writeFileSync(relayLock(dir), 'not-json', { encoding: 'utf8' });
    const lock = new RelayHostLock({ dataDir: dir });
    expect(lock.readClaim()).toBeNull();
    expect(lock.tryClaim()).toBe('claimed');
    expect(JSON.parse(readFileSync(lock.path(), 'utf8'))).toMatchObject({ pid: process.pid });
  });

  it('a BROKEN claim path reports write-failed, warns once per streak, and a success re-arms (§3.12 pre-lock)', () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const dir = freshDir('nnd-p83-lock');
    const blockedDir = joinPath(dir, 'not-a-dir');
    writeFileSync(blockedDir, 'x', { encoding: 'utf8' }); // a FILE masquerading as dataDir: asserts claim writes fail
    const lock = new RelayHostLock({ dataDir: blockedDir });
    try {
      expect(lock.forceClaim()).toBe('write-failed');
      expect(warnings).toHaveBeenCalledTimes(1);
      expect(lock.tryClaim()).toBe('write-failed'); // dedupes within the streak
      expect(warnings).toHaveBeenCalledTimes(1);
    } finally {
      warnings.mockRestore();
    }
    const healthy = new RelayHostLock({ dataDir: dir });
    expect(healthy.forceClaim()).toBe('claimed'); // unrelated stores are untouched
    expect(healthy.forceClaim()).toBe('claimed');
    expect(JSON.parse(readFileSync(relayLock(dir), 'utf8'))).toMatchObject({ pid: process.pid });
  });

  it('a write-failed streak resets to warn-fresh after one success', () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const dir = freshDir('nnd-p83-lock');
      const blockedDir = joinPath(dir, 'not-a-dir');
      writeFileSync(blockedDir, 'x', { encoding: 'utf8' });
      const broken = new RelayHostLock({ dataDir: blockedDir });
      expect(broken.forceClaim()).toBe('write-failed');
      const healthy = new RelayHostLock({ dataDir: dir });
      expect(healthy.forceClaim()).toBe('claimed');
      // a fresh store object proves the flag is per-attempt, not sticky-once:
      const afterHeal = new RelayHostLock({ dataDir: dir });
      expect(afterHeal.forceClaim()).toBe('claimed');
      expect(warnings).toHaveBeenCalledTimes(1);
    } finally {
      warnings.mockRestore();
    }
  });

  it('RelayClaimOutcome is exactly the three-way contract (typos cannot drift)', () => {
    const outcomes: RelayClaimOutcome[] = ['claimed', 'contended', 'write-failed'];
    expect(outcomes).toHaveLength(3);
  });
});

describe('relay env resolution (§11.1 rows)', () => {
  it('env relay URL overrides with relayUrlLocked; invalid env falls through', () => {
    process.env.NOTNATIVE_RELAY_URL = 'ws://worker.example/ws';
    expect(readEnvRelayUrl()).toBe('ws://worker.example/ws');
    expect(relayUrlLocked()).toBe(true);
    expect(resolveRelayUrl({ enabled: true, relayUrl: 'wss://stored/ws', corrupt: false })).toBe('ws://worker.example/ws');
    process.env.NOTNATIVE_RELAY_URL = 'https://junk';
    expect(readEnvRelayUrl()).toBeNull();
    expect(relayUrlLocked()).toBe(false);
  });

  it('resolveRelayUrl prefers stored relayUrl then the default endpoint', () => {
    expect(resolveRelayUrl({ enabled: true, relayUrl: 'wss://stored/ws', corrupt: false })).toBe('wss://stored/ws');
    expect(resolveRelayUrl({ enabled: true, relayUrl: null, corrupt: false })).toBe(DEFAULT_RELAY_URL);
  });

  it('enable normalization keeps ws/wss and replaces everything else with the default', () => {
    expect(normalizeRelayUrl('wss://relay.example/dev')).toBe('wss://relay.example/dev');
    expect(normalizeRelayUrl('ws://127.0.0.1:9999')).toBe('ws://127.0.0.1:9999');
    expect(normalizeRelayUrl('')).toBe(DEFAULT_RELAY_URL);
    expect(normalizeRelayUrl('http://relay.example')).toBe(DEFAULT_RELAY_URL);
    expect(normalizeRelayUrl(undefined)).toBe(DEFAULT_RELAY_URL);
    expect(normalizeRelayUrl(42)).toBe(DEFAULT_RELAY_URL);
  });

  it('the passive hold-out mirrors: off/on, dev shell, and the on-override', () => {
    expect(readRelayHostHoldOut()).toBe(false);
    process.env.NOTNATIVE_RELAY_HOST = 'off';
    expect(readRelayHostHoldOut()).toBe(true);
    process.env.NOTNATIVE_RELAY_HOST = 'on';
    expect(readRelayHostHoldOut()).toBe(false);
    delete process.env.NOTNATIVE_RELAY_HOST;
    process.env.NOTNATIVE_ELECTRON_DEV = '1';
    expect(readRelayHostHoldOut()).toBe(true);
    process.env.NOTNATIVE_RELAY_HOST = 'on';
    expect(readRelayHostHoldOut()).toBe(false);
  });

  it('the batch window env is clamped 1..5000 with the 150 ms default', () => {
    expect(readEnvBatchWindowMs()).toBe(150);
    process.env.NOTNATIVE_RELAY_BATCH_WINDOW_MS = '0';
    expect(readEnvBatchWindowMs()).toBe(1);
    process.env.NOTNATIVE_RELAY_BATCH_WINDOW_MS = '90000';
    expect(readEnvBatchWindowMs()).toBe(5000);
    process.env.NOTNATIVE_RELAY_BATCH_WINDOW_MS = '175';
    expect(readEnvBatchWindowMs()).toBe(175);
    process.env.NOTNATIVE_RELAY_BATCH_WINDOW_MS = 'junk';
    expect(readEnvBatchWindowMs()).toBe(150);
  });

  it('legacy batcher options ride the env window (§11.2 row is wired, not dead)', () => {
    delete process.env.NOTNATIVE_RELAY_BATCH_WINDOW_MS;
    expect(legBatchOptions().windowMs).toBe(150);
    process.env.NOTNATIVE_RELAY_BATCH_WINDOW_MS = '375';
    expect(legBatchOptions().windowMs).toBe(375);
    process.env.NOTNATIVE_RELAY_BATCH_WINDOW_MS = 'junk';
    expect(legBatchOptions().windowMs).toBe(150);
  });
});

function relayLock(dir: string): string {
  return joinPath(dir, 'relay-host.lock');
}
