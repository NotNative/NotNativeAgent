// SPDX-License-Identifier: Apache-2.0
/**
 * P8-5b route-shape contract (doc 08 §5.1/§5.3/§6.1): the UI pairing client
 * (packages/ui/src/lib/pairing-client.ts + pairing-watch.ts) is pointed at the
 * REAL gated routes in routes/client-auth.ts. Every other pairing test either
 * fakes the transport (ui) or asserts the server alone (p8-4a / p8-4b); this
 * file is the seam between them, so a field rename, a status change, a
 * sanitization slip, or a candidate-shape drift fails here instead of inside
 * the dialog.
 *
 * The UI fetch seam is bridged onto the harness over absolute URLs: no pairing
 * path is on the runtimeFetch coalescing allowlist, so the bridge never has to
 * care whether a call carries a relative or an absolute URL. The bridge owns
 * the credential — the dialog never holds one (§2.8: the browser session cookie
 * is the only credential the UI keeps).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clientAuthHarness } from './helpers/client-auth-harness.ts';
import { getPairingSessionStore } from '../lib/auth/pairing-sessions.ts';
import { getRelayHostService } from '../lib/relay/host-service.ts';
import { serverLabel, serverTransports } from '../lib/auth/pairing-candidates.ts';
import { parsePairingConnectionPayload } from '@notnative/ui/lib/connection-payload.ts';
import {
  cancelPairingSession,
  createPairingLink,
  createPairingRuntime,
  fetchPairingTransports,
  listPendingPairings,
  listRemoteClients,
  PairingApiError,
} from '@notnative/ui/lib/pairing-client.ts';
import {
  createPairingWatchState,
  observePairingPoll,
  pollPairingResult,
} from '@notnative/ui/lib/pairing-watch.ts';

const h = clientAuthHarness();
const UI_PASSWORD = 'p8-5b-route-shape';
const BASE = 'http://127.0.0.1:3902';
const RELAY_WS = 'wss://relay.openchamber.dev/ws';

let sessionCookie = '';

async function loginCookie(): Promise<string> {
  const login = await h.call('/auth/session', {
    method: 'POST',
    body: { password: UI_PASSWORD },
    socket: { remoteAddress: '127.0.0.1' },
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  expect(cookie).not.toBe('');
  return cookie;
}

type BridgeInit = { method?: string; body?: string | null };
type UiFetch = (input: string | { url: string }, init?: BridgeInit) => Promise<Response>;
type RuntimeFetch = ReturnType<typeof createPairingRuntime>['fetch'];

interface StubTurn {
  path: string;
  status: number;
  body: unknown;
  method?: string;
}

/** Offline stand-in for the malformed/degraded-path rows: no harness route is
 * involved, only the ui reader's tolerance for a broken body. */
function responder(turns: readonly StubTurn[]): { fetch: RuntimeFetch; calls: string[] } {
  const calls: string[] = [];
  const run = async (input: string | { url: string }, init?: BridgeInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.url, BASE);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.pathname}`);
    const turn = turns.find((row) => row.path === url.pathname && (row.method ?? 'GET') === method);
    if (turn === undefined) throw new ErrorLike(`unstubbed ${method} ${url.pathname}`);
    return new Response(JSON.stringify(turn.body), {
      status: turn.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: run as unknown as RuntimeFetch, calls };
}

class ErrorLike extends Error {}


/** Re-hydration for the JSON the dialog writes; a non-JSON body never reaches here. */
function rehydrate(value: string): unknown {
  return JSON.parse(value);
}

/** Bridges the ui fetch seam (url plus init) onto the harness. */
function bridge(cookie: string): typeof globalThis.fetch {
  const call: UiFetch = async (input, init) => {
    const raw = typeof input === 'string' ? input : input.url;
    const url = new URL(raw, BASE);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? rehydrate(init.body) : undefined;
    const response = await h.call(`${url.pathname}${url.search}`, {
      method,
      ...(body === undefined ? {} : { body }),
      ...(cookie === '' ? {} : { cookie }),
    });
    return new Response(await response.text(), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return call as unknown as typeof globalThis.fetch;
}

function uiRuntime(cookie: string = sessionCookie) {
  return createPairingRuntime({ fetch: bridge(cookie), now: () => Date.now() });
}

beforeAll(async () => {
  process.env.NOTNATIVE_UI_PASSWORD = UI_PASSWORD;
  sessionCookie = await loginCookie();
});

afterAll(() => {
  delete process.env.NOTNATIVE_UI_PASSWORD;
  h.dispose();
});

beforeEach(() => {
  h.resetPairingSlate();
});

describe('transports route feeds the ui reader (6.1 step 1)', () => {
  it('local / lan / relayAvailable read straight off the real wire', async () => {
    h.seedService('real');
    const route = await h.call('/api/client-auth/pairing/transports', { cookie: sessionCookie });
    expect(route.status).toBe(200);
    const wire = (await route.json()) as { local: string; lan: string | null; relayAvailable: boolean };
    expect(wire.local).toBe('http://127.0.0.1:3902');
    expect(wire.lan).toBeNull();
    expect(wire.relayAvailable).toBe(false);

    const read = await fetchPairingTransports(uiRuntime());
    expect(read).toEqual({ local: wire.local, lan: wire.lan, relayAvailable: false });
    // The ui local string is the same value the server derived for this bind.
    const port = Number(new URL(wire.local).port);
    expect(serverTransports({ host: '127.0.0.1', port }).local).toBe(read.local);
  });

  it('a partial body degrades to the locked shape instead of throwing', async () => {
    const stub = responder([{ path: '/api/client-auth/pairing/transports', status: 200, body: { lan: 42 } }]);
    const runtime = createPairingRuntime({ fetch: stub.fetch, now: () => Date.now() });
    await expect(fetchPairingTransports(runtime)).resolves.toEqual({
      local: '',
      lan: null,
      relayAvailable: false,
    });
    expect(stub.calls).toEqual(['GET /api/client-auth/pairing/transports']);
  });

});

describe('create route feeds the ui link builder (6.1 steps 3-4, 5.1 payload)', () => {
  it('201 body shape survives the ui reader and encodes a parseable v2 link', async () => {
    h.seedService('false');
    const runtime = uiRuntime();
    const created = await createPairingLink(
      { scope: 'local', transports: { local: 'http://127.0.0.1:3902', lan: null, relayAvailable: false }, label: 'Pixel 9', relayFallback: false },
      runtime,
    );
    expect(created.response.pairing.id).toMatch(/^pair_[0-9a-f]{24}$/u);
    expect(created.response.pairing.secret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(created.planned.serverUrl).toBe('http://127.0.0.1:3902');
    expect(created.planned.includeRelay).toBe(false);
    expect(created.planned.label).toBe('Pixel 9');

    // The route answers in the 5.1 candidate shape; the ui encoder + parser
    // round-trip it. A drift in either direction lands here.
    const parsed = parsePairingConnectionPayload(created.link);
    expect(parsed).not.toBeNull();
    expect(parsed?.pairingId).toBe(created.response.pairing.id);
    expect(parsed?.secret).toBe(created.response.pairing.secret);
    expect(parsed?.label).toBe(serverLabel());
    expect(parsed?.fingerprint).toBe(created.response.pairing.fingerprint);
    expect(parsed?.candidates).toEqual(created.response.server.candidates);
    expect(parsed?.candidates[0]).toEqual({ type: 'lan', url: 'http://127.0.0.1:3902', priority: 10 });
  });

  it('the pending row the ui reads carries no secret and matches the created id', async () => {
    h.seedService('false');
    const created = await createPairingLink(
      { scope: 'local', transports: { local: 'http://127.0.0.1:3902', lan: null, relayAvailable: false }, label: 'tablet', relayFallback: false },
      uiRuntime(),
    );
    const rows = await listPendingPairings(uiRuntime());
    const row = rows.find((candidate) => candidate.id === created.response.pairing.id);
    expect(row).toBeDefined();
    expect(row?.label).toBe('tablet');
    expect(row?.expiresAt).toBe(created.response.pairing.expiresAt);
    expect(JSON.stringify(row)).not.toContain('secret');
  });

  it('the relay leg turns an honest no-relay into a 503 the dialog can show', async () => {
    h.seedService('false');
    const service = getRelayHostService();
    const original = service.ensureEnabledForPairing;
    service.ensureEnabledForPairing = async () => null; // honest "no relay right now"
    try {
      await expect(
        createPairingLink(
          {
            scope: 'anywhere',
            transports: { local: 'http://127.0.0.1:3902', lan: null, relayAvailable: true } as never,
            label: '',
            relayFallback: false,
          },
          uiRuntime(),
        ),
      ).rejects.toMatchObject({ status: 503 });
    } finally {
      service.ensureEnabledForPairing = original;
    }
  });
});

describe('pending + client lists drive the watcher off real rows (6.1 steps 5/8/9)', () => {
  function mintSession() {
    return getPairingSessionStore().createPairingSession({ label: 'watch me', allowedClientKinds: ['mobile'] });
  }

  async function redeem(session: { id: string; secret?: string }) {
    return h.call('/api/client-auth/pairing/redeem', {
      method: 'POST',
      body: { pairingId: session.id, secret: session.secret, clientKind: 'mobile' },
      socket: { remoteAddress: '203.0.113.77', localAddress: '127.0.0.1', localPort: 3902 },
    });
  }

  it('a real redeem moves the watcher to redeemed through the ui readers', async () => {
    h.seedService('false');
    const session = mintSession();
    const state = createPairingWatchState(session.id, session.expiresAt);

    const first = await pollPairingResult(session.id, uiRuntime());
    expect(first.ok).toBe(true);
    observePairingPoll(state, first, Date.now());
    expect(state.seenPending).toBe(true);
    expect(state.closed).toBeNull();

    expect((await redeem(session)).status).toBe(200);
    const second = await pollPairingResult(session.id, uiRuntime());
    observePairingPoll(state, second, Date.now());
    expect(state.redeemed).toBe(true);
    expect(state.closed).toBe('redeemed');
  });

  it('a real cancel closes as cancelled, never redeemed', async () => {
    h.seedService('false');
    const session = mintSession();
    const state = createPairingWatchState(session.id, session.expiresAt);
    observePairingPoll(state, await pollPairingResult(session.id, uiRuntime()), Date.now());
    expect(state.seenPending).toBe(true);

    expect(await cancelPairingSession(session.id, uiRuntime())).toBe(true);
    observePairingPoll(state, await pollPairingResult(session.id, uiRuntime()), Date.now());
    expect(state.redeemed).toBe(false);
    expect(state.closed).toBe('cancelled');
  });

  it('cancelling an unknown id surfaces the route 404 as PairingApiError', async () => {
    h.seedService('false');
    await expect(cancelPairingSession('pair_000000000000000000000000', uiRuntime()))
      .rejects.toMatchObject({ status: 404 });
  });

  it('the client row the ui reads carries pairingId and never tokenHash (2.7)', async () => {
    h.seedService('false');
    const session = mintSession();
    expect((await redeem(session)).status).toBe(200);
    const rows = await listRemoteClients(uiRuntime());
    const row = rows.find((candidate) => candidate.pairingId === session.id);
    expect(row).toBeDefined();
    expect(row?.label).toBe('watch me');
    expect(row?.revokedAt).toBeNull();
    const wire = await (await h.call('/api/client-auth/clients', { cookie: sessionCookie })).json();
    expect(JSON.stringify(wire)).not.toContain('tokenHash');
  });
});



