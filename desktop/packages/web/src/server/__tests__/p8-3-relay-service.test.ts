// SPDX-License-Identifier: Apache-2.0
/**
 * P8-3a gates part 2 (doc 08 §3.12 lifecycle + §3.15 routes): the relay
 * host service is driven with FAKE managed hosts — the demand matrix (any
 * affirmative wins; a failed check throws and never severs a live host),
 * the hold-out, the machine-claim watcher stand-down, the takeover grace,
 * ensureEnabledForPairing/enable/disable, and the three management routes
 * through the real app + auth gate.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath, sep } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createRelayHostService,
  getRelayHostService,
  resetRelayHostServiceForTests,
  type RelayHostService,
} from '../lib/relay/host-service.ts';
import { RelayConfigStore, relayConfigPath } from '../lib/relay/relay-config.ts';
import { RelayHostLock } from '../lib/relay/host-lock.ts';
import { RelayIdentityStore, resetSharedRelayIdentityForTests } from '../lib/relay/identity.ts';
import type { ManagedHost } from '../lib/relay/host-service-types.ts';
import { relayLockPath } from './helpers/relay-lock-paths.ts';

const isolatedDataDir = mkdtempSync(`${tmpdir()}${sep}nnd-p83-service-`);
process.env.NOTNATIVE_DATA_DIR = isolatedDataDir;
delete process.env.NOTNATIVE_RELAY_URL;
delete process.env.NOTNATIVE_RELAY_HOST;
delete process.env.NOTNATIVE_ELECTRON_DEV;
const scratch: string[] = [];
type App = { fetch: (request: Request) => Promise<Response> };
let app: App | null = null;

afterAll(() => {
  resetRelayHostServiceForTests();
  resetSharedRelayIdentityForTests();
  rmSync(isolatedDataDir, { recursive: true, force: true });
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  delete process.env.NOTNATIVE_RELAY_URL;
  delete process.env.NOTNATIVE_RELAY_HOST;
  delete process.env.NOTNATIVE_ELECTRON_DEV;
});

beforeEach(() => {
  delete process.env.NOTNATIVE_RELAY_HOST;
  delete process.env.NOTNATIVE_ELECTRON_DEV;
  resetRelayHostServiceForTests();
});

function freshDir(): string {
  const made = mkdtempSync(`${tmpdir()}${sep}nnd-p83-`);
  scratch.push(made);
  return made;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 1500, stepMs = 8): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      void Promise.resolve()
        .then(predicate)
        .then((met) => {
          if (met) { resolve(); return; }
          if (Date.now() - start > timeoutMs) { reject(new Error('condition not reached in time')); return; }
          setTimeout(tick, stepMs);
        })
        .catch(reject);
    };
    tick();
  });
}

interface FakeKit {
  hosts: FakeHostRecord[];
  factory: (_identity: unknown, _relayUrl: string) => Promise<ManagedHost>;
}

interface FakeHostRecord {
  started: string[];
  stopped: number;
  state: 'connecting' | 'connected' | 'disabled' | 'reconnecting';
}

function fakeKit(): FakeKit {
  const hosts: FakeHostRecord[] = [];
  const factory = async (_identity: unknown, relayUrl: string): Promise<ManagedHost> => {
    const record: FakeHostRecord = { started: [relayUrl], stopped: 0, state: 'connected' };
    hosts.push(record);
    return {
      start: async (input: { relayUrl: string }) => {
        record.started.push(input.relayUrl);
      },
      stop: () => {
        record.stopped += 1;
        record.state = 'disabled';
      },
      getStatus: () => ({
        state: record.state,
        serverId: 'srv-test',
        connectedClients: 0,
        relayUrl: record.started[0] ?? null,
        lastError: null,
      }),
    };
  };
  return { hosts, factory };
}

const TEST_TIMING = { claimWatcherMs: 10, demandPollMs: 60_000, claimTakeoverGraceMs: 120 };
const ROUTE_TIMING = { claimWatcherMs: 10, demandPollMs: 60_000, claimTakeoverGraceMs: 120 };
const demand = (value: boolean | 'boom'): (() => boolean) => {
  if (value === 'boom') return () => { throw new Error('store exploded'); };
  return () => value === true;
};

function buildService(kit: FakeKit, dir: string, signals: (() => boolean)[]): RelayHostService {
  return createRelayHostService({
    dataDir: dir,
    identity: new RelayIdentityStore(dir),
    config: new RelayConfigStore(dir),
    lock: new RelayHostLock({ dataDir: dir }),
    demandSignals: signals,
    timing: TEST_TIMING,
    hostFactory: kit.factory,
  });
}

beforeAll(async () => {
  const { createApp } = await import('../app.ts');
  app = { fetch: (request: Request) => Promise.resolve(createApp().fetch(request)) };
  resetRelayHostServiceForTests();
});

describe('relay host service lifecycle (fake hosts, doc 08 §3.12)', () => {
  it('demand=false stays off: no host is built and the config stays disabled', async () => {
    const dir = freshDir();
    const kit = fakeKit();
    const service = buildService(kit, dir, [demand(false)]);
    await service.reconcile();
    expect(kit.hosts).toHaveLength(0);
    expect(new RelayConfigStore(dir).read().enabled).toBe(false);
    const status = await service.getStatus();
    expect(status).toMatchObject({ enabled: false, state: 'disabled', relayUrl: 'wss://relay.openchamber.dev/ws' });
    expect(status.serverId).not.toBeNull();
  });

  it('demand=true builds and starts the host with the resolved URL and persists enabled', async () => {
    const dir = freshDir();
    const kit = fakeKit();
    const service = buildService(kit, dir, [demand(true)]);
    await service.reconcile();
    expect(kit.hosts).toHaveLength(1);
    expect(new RelayConfigStore(dir).read()).toMatchObject({ enabled: true, relayUrl: null });
    expect(await service.getStatus()).toMatchObject({
      enabled: true,
      state: 'connected',
      relayUrl: 'wss://relay.openchamber.dev/ws',
      relayUrlLocked: false,
    });
  });

  it('demand flipping false stops the host and persists the disabled truth', async () => {
    const dir = freshDir();
    let flag = true;
    const kit = fakeKit();
    const service = buildService(kit, dir, [() => flag]);
    await service.reconcile();
    expect(kit.hosts[0]!.stopped).toBe(0);
    flag = false;
    await service.reconcile();
    expect(kit.hosts[0]!.stopped).toBe(1);
    expect(new RelayConfigStore(dir).read().enabled).toBe(false);
    expect((await service.getStatus()).state).toBe('disabled');
  });

  it('a demand read failure with NO affirmative throws and never stops a running host', async () => {
    const dir = freshDir();
    const kit = fakeKit();
    let mode: 'up' | 'boom' = 'up';
    const service = buildService(kit, dir, [() => {
      if (mode === 'boom') throw new Error('store exploded');
      return true;
    }]);
    await service.reconcile();
    expect(kit.hosts).toHaveLength(1);
    mode = 'boom';
    await expect(service.reconcile()).rejects.toThrow(/demand evaluation failed/);
    expect(kit.hosts[0]!.stopped).toBe(0);
    expect(new RelayConfigStore(dir).read().enabled).toBe(true);
  });

  it('an affirmative demand wins over a concurrent failed read', async () => {
    const dir = freshDir();
    const kit = fakeKit();
    const service = buildService(kit, dir, [demand('boom'), demand(true)]);
    await service.reconcile();
    expect(kit.hosts).toHaveLength(1);
    expect(new RelayConfigStore(dir).read().enabled).toBe(true);
  });

  it('the hold-out suppresses boot/demand hosting and answers standby-style state', async () => {
    process.env.NOTNATIVE_ELECTRON_DEV = '1';
    const dir = freshDir();
    const kit = fakeKit();
    const service = buildService(kit, dir, [demand(true)]);
    await service.reconcile();
    expect(kit.hosts).toHaveLength(0);
    const status = await service.getStatus();
    expect(status.state).toBe('standby');
    expect(status.lastError).toContain('passive hold-out');
    expect(status.enabled).toBe(true); // demand wrote its truth; hosting stays held
    delete process.env.NOTNATIVE_ELECTRON_DEV;
    await service.reconcile();
    expect(kit.hosts).toHaveLength(1);
  });

  it('the hold-out does NOT block the pairing turn-on: force-claim hosts anyway', async () => {
    process.env.NOTNATIVE_RELAY_HOST = 'off';
    const dir = freshDir();
    const kit = fakeKit();
    const service = buildService(kit, dir, [demand(false)]);
    const candidate = await service.ensureEnabledForPairing();
    expect(kit.hosts).toHaveLength(1);
    expect(candidate).toMatchObject({
      type: 'relay',
      relayUrl: 'wss://relay.openchamber.dev/ws',
      priority: 30,
      serverId: expect.any(String),
    });
    expect(Object.keys(candidate!.hostEncPubJwk).sort()).toEqual(['crv', 'kty', 'x', 'y']);
    expect(new RelayConfigStore(dir).read().enabled).toBe(true);
  });

  it('a live foreign claimant stands a demand-start down into standby with the pid note', async () => {
    const dir = freshDir();
    writeFileSync(relayLockPath(dir), JSON.stringify({ pid: 575000, claimedAt: '2026-01-01' }), { encoding: 'utf8' });
    const kit = fakeKit();
    const service = createRelayHostService({
      dataDir: dir,
      identity: new RelayIdentityStore(dir),
      config: new RelayConfigStore(dir),
      lock: new RelayHostLock({ dataDir: dir, processAlive: (pid) => pid === 575000 || pid === process.pid }),
      demandSignals: [demand(true)],
      timing: TEST_TIMING,
      hostFactory: kit.factory,
    });
    await service.reconcile();
    expect(kit.hosts).toHaveLength(0);
    const status = await service.getStatus();
    expect(status.state).toBe('standby');
    expect(status.lastError).toContain('pid 575000');
  });

  it('the watcher stands a RUNNING host down when a foreign claim appears', async () => {
    const dir = freshDir();
    const kit = fakeKit();
    const probe = (pid: number): boolean => pid === 575111 || pid === process.pid;
    const service = createRelayHostService({
      dataDir: dir,
      identity: new RelayIdentityStore(dir),
      config: new RelayConfigStore(dir),
      lock: new RelayHostLock({ dataDir: dir, processAlive: probe }),
      demandSignals: [demand(true)],
      timing: TEST_TIMING,
      hostFactory: kit.factory,
    });
    service.start();
    await waitUntil(() => kit.hosts.length === 1);
    expect((await service.getStatus()).state).toBe('connected');
    writeFileSync(relayLockPath(dir), JSON.stringify({ pid: 575111, claimedAt: 'now' }), { encoding: 'utf8' });
    await waitUntil(() => kit.hosts[0]!.stopped === 1);
    const status = await service.getStatus();
    expect(status.state).toBe('standby');
    expect(status.lastError).toContain('pid 575111');
    expect(kit.hosts).toHaveLength(1);
    await service.dispose();
  });

  it('standby takes a FREED claim only after the takeover grace; the boot path is instant', async () => {
    const dir = freshDir();
    writeFileSync(relayLockPath(dir), JSON.stringify({ pid: 575222, claimedAt: 'now' }), { encoding: 'utf8' });
    let foreign = true;
    const kit = fakeKit();
    const service = createRelayHostService({
      dataDir: dir,
      identity: new RelayIdentityStore(dir),
      config: new RelayConfigStore(dir),
      lock: new RelayHostLock({ dataDir: dir, processAlive: () => foreign }),
      demandSignals: [demand(true)],
      timing: TEST_TIMING,
      hostFactory: kit.factory,
    });
    service.start();
    await waitUntil(() => (async () => (await service.getStatus()).state === 'standby')(), 1200);
    expect(kit.hosts).toHaveLength(0);
    foreign = false; // the claimant died days ago: the file is stale now
    rmSync(relayLockPath(dir));
    await sleep(60); // well inside the 120 ms grace
    expect(kit.hosts).toHaveLength(0); // the watcher honors the grace
    expect((await service.getStatus()).state).toBe('standby');
    await waitUntil(() => kit.hosts.length === 1, 1200); // grace passes -> takeover
    expect((await service.getStatus()).state).toBe('connected');
    expect(JSON.parse(readFileSync(relayLockPath(dir), 'utf8'))).toMatchObject({ pid: process.pid });
    await service.dispose();
  });

  it('a fresh boot reclaims a stale claim instantly (no grace on restart)', async () => {
    const dir = freshDir();
    writeFileSync(relayLockPath(dir), JSON.stringify({ pid: 575333, claimedAt: 'old' }), { encoding: 'utf8' });
    const kit = fakeKit();
    const service = buildService(kit, dir, [demand(true)]);
    await service.reconcile(); // the stale pid is not alive -> claimable without waiting
    expect(kit.hosts).toHaveLength(1);
    expect((await service.getStatus()).state).toBe('connected');
    expect(JSON.parse(readFileSync(relayLockPath(dir), 'utf8'))).toMatchObject({ pid: process.pid });
  });

  it('disable persists the off-truth, stops the host and releases the claim', async () => {
    const dir = freshDir();
    const kit = fakeKit();
    const service = buildService(kit, dir, [demand(true)]);
    await service.reconcile();
    const status = await service.disable();
    expect(status.enabled).toBe(false);
    expect(status.state).toBe('disabled');
    expect(kit.hosts[0]!.stopped).toBe(1);
    expect(new RelayConfigStore(dir).read().enabled).toBe(false);
    let gone = false;
    try {
      readFileSync(relayLockPath(dir));
    } catch {
      gone = true;
    }
    expect(gone).toBe(true);
  });

  it('enable persists and restarts force even when a host already stands', async () => {
    const dir = freshDir();
    const kit = fakeKit();
    const service = buildService(kit, dir, [demand(true)]);
    await service.reconcile();
    expect(kit.hosts).toHaveLength(1);
    const status = await service.enable('wss://relay.example/deep/ws');
    expect(status.enabled).toBe(true);
    expect(status.state).toBe('connected');
    expect(new RelayConfigStore(dir).read()).toMatchObject({ enabled: true, relayUrl: 'wss://relay.example/deep/ws' });
    expect(kit.hosts).toHaveLength(2); // stop -> fresh builder -> start
    expect(kit.hosts[0]!.stopped).toBe(1);
  });

  it('ensureEnabledForPairing reclaims authority with a force-claim while running (no churn)', async () => {
    const dir = freshDir();
    const kit = fakeKit();
    const service = buildService(kit, dir, [demand(true)]);
    await service.reconcile();
    writeFileSync(relayLockPath(dir), JSON.stringify({ pid: process.pid, claimedAt: 'old' }), { encoding: 'utf8' });
    const candidate = await service.ensureEnabledForPairing();
    expect(kit.hosts).toHaveLength(1); // the running host keeps its legs
    expect(candidate).not.toBeNull();
    expect(JSON.parse(readFileSync(relayLockPath(dir), 'utf8'))).toMatchObject({ pid: process.pid });
  });

  it('a write-FAILING claim keeps the §3.12 pre-lock posture: the host starts anyway', async () => {
    const dir = freshDir();
    const brokenDir = joinPath(dir, 'not-a-dir');
    writeFileSync(brokenDir, 'x', { encoding: 'utf8' });
    const kit = fakeKit();
    const service = createRelayHostService({
      dataDir: brokenDir,
      identity: new RelayIdentityStore(dir), // keys live on the healthy dir; the CLAIM dir is broken
      config: new RelayConfigStore(dir),
      lock: new RelayHostLock({ dataDir: brokenDir }),
      demandSignals: [demand(true)],
      timing: TEST_TIMING,
      hostFactory: kit.factory,
    });
    await service.reconcile(); // write-failed (not contended) -> host starts; the worker arbitrates
    expect(kit.hosts).toHaveLength(1);
    const status = await service.getStatus();
    expect(status.state).toBe('connected');
    expect(status.enabled).toBe(true);
    expect(new RelayConfigStore(dir).read().enabled).toBe(true);
  });

  it('the demand poll survives disable and revives hosting when demand resurfaces', async () => {
    const dir = freshDir();
    let flag = false;
    const kit = fakeKit();
    const service = createRelayHostService({
      dataDir: dir,
      identity: new RelayIdentityStore(dir),
      config: new RelayConfigStore(dir),
      lock: new RelayHostLock({ dataDir: dir }),
      demandSignals: [() => flag],
      timing: { claimWatcherMs: 10, demandPollMs: 30, claimTakeoverGraceMs: 120 },
      hostFactory: kit.factory,
    });
    service.start(); // arms the 30 ms test poll
    await waitUntil(() => kit.hosts.length === 0 && new RelayConfigStore(dir).read().enabled === false);
    const off = await service.disable();
    expect(off.enabled).toBe(false);
    expect(kit.hosts).toHaveLength(0);
    flag = true; // headless pairing write; only the armed poll can see it (§3.12)
    await waitUntil(() => kit.hosts.length === 1, 1500);
    expect((await service.getStatus()).state).toBe('connected');
    expect(new RelayConfigStore(dir).read().enabled).toBe(true);
    await service.dispose();
  });

  it('a corrupt config aborts the pairing/enable turn-ons, and disable degrades to off', async () => {
    const dir = freshDir();
    writeFileSync(relayConfigPath(dir), '{"version":2}', { encoding: 'utf8' });
    const kit = fakeKit();
    const service = buildService(kit, dir, [demand(true)]);
    await expect(service.ensureEnabledForPairing()).rejects.toThrow(/corrupt/);
    await expect(service.enable('ws://relay.example')).rejects.toThrow(/corrupt/);
    expect(kit.hosts).toHaveLength(0);
    const status = await service.disable();
    expect(status.enabled).toBe(false);
    expect(status.lastError).toContain('corrupt');
  });
});

describe('relay routes through the real gate (§3.15)', () => {
  it('GET status answers the lifecycle truth; a throwing config answers 500', async () => {
    const dir = freshDir();
    const kit = fakeKit();
    const singletonConfig = new RelayConfigStore(dir);
    getRelayHostService({
      dataDir: dir,
      identity: new RelayIdentityStore(dir),
      config: singletonConfig,
      lock: new RelayHostLock({ dataDir: dir }),
      demandSignals: [demand(true)],
      timing: ROUTE_TIMING,
      hostFactory: kit.factory,
    }).start();
    await waitUntil(() => kit.hosts.length === 1);
    const status0 = await app!.fetch(new Request('http://local/api/openchamber/relay/status'));
    expect(status0.status).toBe(200);
    expect(await status0.json()).toMatchObject({ enabled: true, state: 'connected' });

    resetRelayHostServiceForTests();
    getRelayHostService({
      dataDir: dir,
      identity: new RelayIdentityStore(dir),
      config: {
        read: () => { throw new Error('store mis-read'); },
        write: () => undefined,
      } as unknown as RelayConfigStore,
      lock: new RelayHostLock({ dataDir: dir }),
      demandSignals: [],
      timing: ROUTE_TIMING,
      hostFactory: kit.factory,
    });
    const status1 = await app!.fetch(new Request('http://local/api/openchamber/relay/status'));
    expect(status1.status).toBe(500);
  });

  it('POST enable normalizes the URL, restarts with force-claim; disable turns it back off', async () => {
    const dir = freshDir();
    const kit = fakeKit();
    getRelayHostService({
      dataDir: dir,
      identity: new RelayIdentityStore(dir),
      config: new RelayConfigStore(dir),
      lock: new RelayHostLock({ dataDir: dir }),
      demandSignals: [demand(false)],
      timing: ROUTE_TIMING,
      hostFactory: kit.factory,
    });
    const post = async (path: string, body?: string): Promise<Response> => app!.fetch(new Request(`http://local${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body } : {}),
    }));
    const enable = await post('/api/openchamber/relay/enable', JSON.stringify({ relayUrl: 'wss://relay.example/deep/ws' }));
    expect(enable.status).toBe(200);
    expect(await enable.json()).toMatchObject({ enabled: true, state: 'connected', relayUrl: 'wss://relay.example/deep/ws' });
    expect(kit.hosts).toHaveLength(1);
    const disable = await post('/api/openchamber/relay/disable');
    expect(disable.status).toBe(200);
    expect(await disable.json()).toMatchObject({ enabled: false, state: 'disabled' });
    expect(kit.hosts[0]!.stopped).toBeGreaterThanOrEqual(1);
  });

  it('POST enable 400s on oversize, non-JSON, or non-string relayUrl bodies', async () => {
    const dir = freshDir();
    getRelayHostService({
      dataDir: dir,
      identity: new RelayIdentityStore(dir),
      config: new RelayConfigStore(dir),
      lock: new RelayHostLock({ dataDir: dir }),
      hostFactory: fakeKit().factory,
    });
    const post = async (body: string): Promise<Response> => app!.fetch(new Request('http://local/api/openchamber/relay/enable', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }));
    expect((await post(JSON.stringify({ relayUrl: 'wss://x' }).padEnd(17 * 1024, ' '))).status).toBe(400);
    expect((await post('not-json')).status).toBe(400);
    expect((await post(JSON.stringify({ relayUrl: 42 }))).status).toBe(400);
    expect((await post('')).status).toBe(200);
  });

  it('POST enable over a corrupt config answers the exact refusal (500)', async () => {
    const dir = freshDir();
    writeFileSync(relayConfigPath(dir), '{"version":2}', { encoding: 'utf8' });
    getRelayHostService({
      dataDir: dir,
      identity: new RelayIdentityStore(dir),
      config: new RelayConfigStore(dir),
      lock: new RelayHostLock({ dataDir: dir }),
      hostFactory: fakeKit().factory,
    });
    const response = await app!.fetch(new Request('http://local/api/openchamber/relay/enable', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ relayUrl: 'wss://relay.example/ws' }),
    }));
    expect(response.status).toBe(500);
    expect((await response.json() as { error: string }).error).toContain('corrupt');
  });

  it('GET /health greets with a serverId once the relay identity exists (E-08-2)', async () => {
    const response = await app!.fetch(new Request('http://local/health'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; serverId: string | null };
    expect(body.ok).toBe(true);
    expect(typeof body.serverId).toBe('string');
    expect(body.serverId!.length).toBeGreaterThan(30);
  });
});
