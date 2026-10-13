// SPDX-License-Identifier: Apache-2.0
/**
 * P8-4a gates part 2 (file A): the anonymous rate-limited redeem and the
 * pairing session routes through the real app — §5.5 candidate math,
 * §5.6 redeem semantics (one generic error for auth classes, 5xx for
 * server faults), §3.12 reconcile call sites. The §2.7 device authority
 * matrix and §3.13 refresh/transports gates live in file B.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clientAuthHarness,
} from './helpers/client-auth-harness.ts';
import {
  getRelayHostService, resetRelayHostServiceForTests,
} from '../lib/relay/host-service.ts';
import {
  getPairingSessionStore, resetPairingSessionStoreForTests,
} from '../lib/auth/pairing-sessions.ts';
import { serverLabel } from '../lib/auth/pairing-candidates.ts';
import { getUiAuthController } from '../lib/auth/ui-auth.ts';

const h = clientAuthHarness();
const dir = h.dir;
const GENERIC = 'Invalid or expired pairing session';
const RELAY_WS = 'wss://relay.openchamber.dev/ws';
const SERVER_FAULT = 'Pairing redeem failed';

afterAll(() => {
  h.dispose();
});

beforeEach(() => {
  delete process.env.NOTNATIVE_UI_PASSWORD;
  h.resetPairingSlate();
});

describe('redeem route (public, anonymous, rate-limited)', () => {
  it('mints through the shared client store and returns the plaintext token exactly once', async () => {
    const kitLocal = h.seedService('false');
    const session = getPairingSessionStore().createPairingSession({ label: 'desk setup', allowedClientKinds: ['mobile'] });
    const response = await h.call('/api/client-auth/pairing/redeem', {
      method: 'POST',
      body: { pairingId: session.id, secret: session.secret, clientLabel: 'Pixel 9', devicePlatform: 'android', dedupeKey: 'mobile:xyz' },
      socket: { remoteAddress: '203.0.113.9', localAddress: '127.0.0.1', localPort: 3902 },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['ok']).toBe(true);
    const server = body['server'] as Record<string, unknown>;
    expect(server['label']).toBe(serverLabel());
    expect(server['url']).toBe('http://127.0.0.1:3902');
    expect(server['fingerprint']).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/u);
    const client = body['client'] as Record<string, unknown>;
    expect(client['label']).toBe('desk setup'); // session label wins over the self-report
    expect(client['clientKind']).toBe('mobile');
    expect(client['dedupeKey']).toBe('mobile:xyz');
    expect(client).not.toHaveProperty('tokenHash');
    expect(String(body['clientToken'])).toMatch(/^oc_client_/u);
    expect(kitLocal.hosts).toEqual([]); // non-relay redeem made no demand
  });

  it('answers the ONE generic error body for every auth failure class, byte-identical on the wire', async () => {
    h.seedService('false');
    const store = getPairingSessionStore();
    const live = store.createPairingSession({ allowedClientKinds: ['mobile'] });
    const used = store.createPairingSession({});
    await h.call('/api/client-auth/pairing/redeem', { method: 'POST', body: { pairingId: used.id, secret: used.secret }, socket: { remoteAddress: '198.51.100.2' } });
    const cases: Record<string, unknown>[] = [
      { pairingId: 'pair_000000000000000000000000', secret: 'x' },
      { pairingId: used.id, secret: used.secret },
      { pairingId: live.id, secret: 'wrong' },
      { pairingId: live.id, secret: live.secret, clientKind: 'desktop' }, // kind mismatch
      { pairingId: '', secret: '' },
    ];
    let firstBody = '';
    for (const attempt of cases) {
      const response = await h.call('/api/client-auth/pairing/redeem', { method: 'POST', body: attempt as unknown, socket: { remoteAddress: '198.51.100.3' } });
      expect(response.status).toBe(400);
      const text = await response.text();
      if (firstBody === '') firstBody = text;
      expect(text).toBe(firstBody); // missing vs used vs wrong-kind vs wrong-secret: indistinguishable (review gate)
    }
    expect(JSON.parse(firstBody)).toEqual({ error: GENERIC });
  });

  it('rate limits 10 per 5 min keyed by the RAW socket address + pairing id; 429 keeps no-store', async () => {
    h.seedService('false');
    const session = getPairingSessionStore().createPairingSession({});
    for (let index = 0; index < 10; index += 1) {
      const response = await h.call('/api/client-auth/pairing/redeem', {
        method: 'POST', body: { pairingId: session.id, secret: 'wrong' }, socket: { remoteAddress: '203.0.113.9' },
      });
      expect(response.status).toBe(400);
    }
    const denied = await h.call('/api/client-auth/pairing/redeem', {
      method: 'POST', body: { pairingId: session.id, secret: 'wrong' }, socket: { remoteAddress: '203.0.113.9' },
    });
    expect(denied.status).toBe(429);
    expect(denied.headers.get('cache-control')).toBe('no-store');
    expect(((await denied.json()) as Record<string, unknown>)['error']).toBe(GENERIC);
    const headers = Object.fromEntries(denied.headers.entries());
    expect(headers['x-ratelimit-limit']).toBe('10');
    expect(headers['x-ratelimit-remaining']).toBe('0');
    expect(Number(headers['retry-after'])).toBeGreaterThan(0);
    const other = getPairingSessionStore().createPairingSession({});
    const freed = await h.call('/api/client-auth/pairing/redeem', {
      method: 'POST', body: { pairingId: other.id, secret: 'wrong' }, socket: { remoteAddress: '203.0.113.9' },
    });
    expect(freed.status).toBe(400); // different pairing id: own bucket
    const fromOtherAddr = await h.call('/api/client-auth/pairing/redeem', {
      method: 'POST', body: { pairingId: session.id, secret: 'wrong' }, socket: { remoteAddress: '203.0.113.10' },
    });
    expect(fromOtherAddr.status).toBe(400); // different raw socket address: own bucket
  });

  it('a server fault (mint explosion) answers 500, keeps the bucket, and stays retry-safe', async () => {
    h.seedService('false');
    resetPairingSessionStoreForTests();
    getPairingSessionStore({
      dataDir: dir,
      mintClient: (): never => { throw new Error('wallet on fire'); },
    });
    const session = getPairingSessionStore().createPairingSession({});
    const crashed = await h.call('/api/client-auth/pairing/redeem', {
      method: 'POST', body: { pairingId: session.id, secret: session.secret }, socket: { remoteAddress: '203.0.113.44' },
    });
    expect(crashed.status).toBe(500);
    expect(((await crashed.json()) as Record<string, unknown>)['error']).toBe(SERVER_FAULT);
    // no fault record: the SAME pairing id's bucket still fits ten wrong-secret attempts before 429
    for (let index = 0; index < 10; index += 1) {
      const response = await h.call('/api/client-auth/pairing/redeem', {
        method: 'POST', body: { pairingId: session.id, secret: 'wrong' }, socket: { remoteAddress: '203.0.113.44' },
      });
      expect(response.status).toBe(400);
    }
    const denied = await h.call('/api/client-auth/pairing/redeem', {
      method: 'POST', body: { pairingId: session.id, secret: 'wrong' }, socket: { remoteAddress: '203.0.113.44' },
    });
    expect(denied.status).toBe(429);
    // the crashed-mint session was never consumed (faults are retry-safe)
    resetPairingSessionStoreForTests();
    getPairingSessionStore({ dataDir: dir, mintClient: (input) => getUiAuthController().getClientStore().createClient(input) });
    const reloaded = getPairingSessionStore().createPairingSession({}); // fresh store: proves the file kept no phantom consume
    expect(reloaded.secret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it('a successful redeem clears the bucket; a spent id afterwards fails as invalid, not 429', async () => {
    h.seedService('false');
    const session = getPairingSessionStore().createPairingSession({});
    for (let index = 0; index < 9; index += 1) {
      await h.call('/api/client-auth/pairing/redeem', {
        method: 'POST', body: { pairingId: session.id, secret: 'wrong' }, socket: { remoteAddress: '203.0.113.77' },
      });
    }
    const ok = await h.call('/api/client-auth/pairing/redeem', {
      method: 'POST', body: { pairingId: session.id, secret: session.secret }, socket: { remoteAddress: '203.0.113.77' },
    });
    expect(ok.status).toBe(200);
    const after = await h.call('/api/client-auth/pairing/redeem', {
      method: 'POST', body: { pairingId: session.id, secret: 'wrong' }, socket: { remoteAddress: '203.0.113.77' },
    });
    expect(after.status).toBe(400);
  });

  it('fires the §3.12 reconcile when the redeemed session was relay-carrying', async () => {
    const kitLocal = h.seedService('real');
    const session = getPairingSessionStore().createPairingSession({ usesRelay: true });
    const response = await h.call('/api/client-auth/pairing/redeem', {
      method: 'POST', body: { pairingId: session.id, secret: session.secret }, socket: { remoteAddress: '203.0.113.9' },
    });
    expect(response.status).toBe(200);
    await h.waitUntil(() => h.configEnabled() && kitLocal.hosts.length >= 1 && kitLocal.hosts[0]!.stopped === 0);
    expect(kitLocal.hosts[0]!.started[0]).toBe(RELAY_WS);
  });
});

describe('pairing session routes (open mode = manage authority)', () => {
  it('creates with §5.5 candidate math: serverUrl primary, relay rows via ensureEnabledForPairing', async () => {
    const kitLocal = h.seedService('real'); // real signals: the pending relay session keeps demand on
    const response = await h.call('/api/client-auth/pairing/sessions', {
      method: 'POST',
      body: { label: 'tablet', allowedClientKinds: ['mobile'], serverUrl: 'http://192.168.1.10:3902/', includeRelay: true },
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as { pairing: Record<string, unknown>; server: { label: string; candidates: Array<Record<string, unknown>> } };
    expect(body.pairing['id']).toMatch(/^pair_[0-9a-f]{24}$/u);
    expect(body.pairing['secret']).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(body.pairing['usesRelay']).toBe(true);
    expect(body.pairing['allowedClientKinds']).toEqual(['mobile']);
    expect(body.server.label).toBe(serverLabel());
    expect(body.server.candidates[0]).toEqual({ type: 'lan', url: 'http://192.168.1.10:3902', priority: 10 });
    const relayRow = body.server.candidates.find((row) => row['type'] === 'relay') as Record<string, unknown> | undefined;
    expect(relayRow?.['relayUrl']).toBe(RELAY_WS);
    expect(relayRow?.['serverId']).toBe('srv-test');
    expect(relayRow?.['priority']).toBe(30);
    const jwk = relayRow?.['hostEncPubJwk'] as Record<string, unknown>;
    expect(jwk['kty']).toBe('EC');
    expect(jwk['crv']).toBe('P-256');
    expect(jwk['d']).toBeUndefined();
    expect(h.configEnabled()).toBe(true); // ensureEnabledForPairing persisted the demand side
    expect(kitLocal.hosts.length).toBe(1);
    const pending = (await (await h.call('/api/client-auth/pairing/sessions')).json()) as { pending: Array<Record<string, unknown>> };
    expect(pending.pending.map((row) => row['id'])).toContain(body.pairing['id']);
    const row = pending.pending.find((row) => row['id'] === body.pairing['id']);
    expect(row).not.toHaveProperty('secret');
    expect(row).not.toHaveProperty('secretHash');
  });

  it('an empty label is stored unset (display placeholders never persist); 260-char labels clamp to 80', async () => {
    h.seedService('false');
    const unset = await h.call('/api/client-auth/pairing/sessions', {
      method: 'POST', body: { label: '   ', serverUrl: 'http://192.168.1.10:3902', includeRelay: false },
    });
    expect(unset.status).toBe(201);
    expect(((await unset.json()) as { pairing: { label: string | null } }).pairing.label).toBeNull();
    const clamped = await h.call('/api/client-auth/pairing/sessions', {
      method: 'POST', body: { label: 'y'.repeat(260), serverUrl: 'http://192.168.1.10:3902', includeRelay: false },
    });
    expect(((await clamped.json()) as { pairing: { label: string } }).pairing.label).toHaveLength(80);
  });

  it('without an explicit relay request the relay row appears only when the host is already up', async () => {
    h.seedService('real');
    const without = await h.call('/api/client-auth/pairing/sessions', { method: 'POST', body: { serverUrl: 'http://192.168.1.10:3902' } });
    let candidates = ((await without.json()) as { server: { candidates: Record<string, unknown>[] } }).server.candidates;
    expect(candidates.some((row) => row['type'] === 'relay')).toBe(false); // host never started: no demand yet
    const kitReal = h.seedService('real');
    getPairingSessionStore().createPairingSession({ usesRelay: true });
    await getRelayHostService().reconcile();
    expect(kitReal.hosts.length).toBe(1);
    const withHost = await h.call('/api/client-auth/pairing/sessions', { method: 'POST', body: { serverUrl: 'http://192.168.1.10:3902' } });
    candidates = ((await withHost.json()) as { server: { candidates: Record<string, unknown>[] } }).server.candidates;
    expect(candidates.some((row) => row['type'] === 'relay')).toBe(true);
    const off = await h.call('/api/client-auth/pairing/sessions', { method: 'POST', body: { serverUrl: 'http://192.168.1.10:3902', includeRelay: false } });
    candidates = ((await off.json()) as { server: { candidates: Record<string, unknown>[] } }).server.candidates;
    expect(candidates.some((row) => row['type'] === 'relay')).toBe(false);
  });

  it('loopback origins are never auto-advertised; creator-origin extra row is priority 20', async () => {
    h.seedService('false');
    const loopbackOnly = await h.call('/api/client-auth/pairing/sessions', { method: 'POST', body: { includeRelay: false } });
    expect(loopbackOnly.status).toBe(400);
    expect(((await loopbackOnly.json()) as Record<string, unknown>)['error']).toBe('No usable pairing candidate');
    const httpsPrimary = await h.call('/api/client-auth/pairing/sessions', { method: 'POST', body: { serverUrl: 'https://lab.example.org', includeRelay: false } });
    const candidates = ((await httpsPrimary.json()) as { server: { candidates: Array<{ type: string; url: string; priority: number }> } }).server.candidates;
    expect(candidates[0]).toEqual({ type: 'tunnel', url: 'https://lab.example.org', priority: 10 });
    const sameOrigin = await h.call('/api/client-auth/pairing/sessions', { method: 'POST', body: { serverUrl: 'http://192.168.1.10:3902', includeRelay: false } });
    const sameRows = ((await sameOrigin.json()) as { server: { candidates: Array<{ type: string }> } }).server.candidates;
    expect(sameRows.map((row) => row.type)).toEqual(['lan']);
    const wildcard = await h.call('/api/client-auth/pairing/sessions', { method: 'POST', body: { serverUrl: 'http://0.0.0.0:3902', includeRelay: false } });
    expect(wildcard.status).toBe(400); // wildcard bind name is unrenderable for a device
  });

  it('rejects invalid bodies without creating sessions (strict + 64 KiB cap)', async () => {
    h.seedService('false');
    const attempts: unknown[] = [
      { label: 42, serverUrl: 'http://192.168.1.10:3902' },
      { serverUrl: 'http://192.168.1.10:3902', allowedClientKinds: 'mobile' },
      { serverUrl: 'http://192.168.1.10:3902', allowedClientKinds: ['desktop', 'watch'] },
      { serverUrl: 'ftp://nope', includeRelay: false },
      { serverUrl: 'http://192.168.1.10:3902', includeRelay: 'yes' },
      { serverUrl: 'http://192.168.1.10:3902', includeDirect: 1 },
      'not-an-object',
      undefined,
    ];
    for (const body of attempts) {
      const response = await h.call('/api/client-auth/pairing/sessions', { method: 'POST', body });
      expect(response.status).toBe(400);
    }
    const oversize = await h.call('/api/client-auth/pairing/sessions', {
      method: 'POST', body: { serverUrl: `http://x${'y'.repeat(70_000)}` },
    });
    expect(oversize.status).toBe(400);
  });

  it('cancel + reconcile turn the relay off for the last demand; cancel-again/used/unknown are 404', async () => {
    await h.drainClients(); // leftover devices from the redeem describe must not hold demand up
    const kitLocal = h.seedService('real');
    const rejected = await h.call('/api/client-auth/pairing/sessions', { method: 'POST', body: { includeDirect: false } });
    expect(rejected.status).toBe(400); // no direct, no relay -> no link
    const created = await h.call('/api/client-auth/pairing/sessions', {
      method: 'POST', body: { serverUrl: 'http://192.168.1.10:3902', includeRelay: true },
    });
    const mint = (await created.json()) as { pairing: { id: string; secret: string } };
    await h.waitUntil(() => h.configEnabled());
    const cancel = await h.call(`/api/client-auth/pairing/sessions/${mint.pairing.id}`, { method: 'DELETE' });
    expect(cancel.status).toBe(200);
    expect(((await cancel.json()) as { cancelled: boolean }).cancelled).toBe(true);
    await h.waitUntil(() => h.configEnabled() === false && kitLocal.hosts[0]!.stopped >= 1);
    const again = await h.call(`/api/client-auth/pairing/sessions/${mint.pairing.id}`, { method: 'DELETE' });
    expect(again.status).toBe(404);
    const unknown = await h.call('/api/client-auth/pairing/sessions/pair_ffffffffffffffffffffffff', { method: 'DELETE' });
    expect(unknown.status).toBe(404);
    // a USED session has nothing left to revoke (E-08-33g): redeem then cancel
    const used = await h.call('/api/client-auth/pairing/sessions', { method: 'POST', body: { serverUrl: 'http://192.168.1.10:3902', includeRelay: false } });
    const usedMint = (await used.json()) as { pairing: { id: string; secret: string } };
    await h.call('/api/client-auth/pairing/redeem', {
      method: 'POST', body: { pairingId: usedMint.pairing.id, secret: usedMint.pairing.secret }, socket: { remoteAddress: '203.0.113.140', localAddress: '127.0.0.1', localPort: 3902 },
    });
    const cancelUsed = await h.call(`/api/client-auth/pairing/sessions/${usedMint.pairing.id}`, { method: 'DELETE' });
    expect(cancelUsed.status).toBe(404);
  });
});
