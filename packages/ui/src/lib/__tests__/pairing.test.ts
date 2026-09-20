// SPDX-License-Identifier: Apache-2.0
/**
 * P8-5b pairing client tests (doc 08 §6.1 steps 1-5/8/9, §5.8): the scope
 * mapping the create route expects, the link assembled from the server's own
 * answer, the silent-poll contract, and the watcher that must never blink the
 * dialog shut on a re-render race or a failed fetch.
 */
import { describe, expect, it } from 'vitest';
import {
  cancelPairingSession,
  createPairingLink,
  createPairingRuntime,
  fetchPairingTransports,
  listPendingPairings,
  listRemoteClients,
  PairingApiError,
  planPairingRequest,
  type PairingRuntime,
  type PairingTransports,
  type PendingPairingRow,
  type RemoteClientRow,
} from '../pairing-client.ts';
import {
  createPairingWatchState,
  observePairingPoll,
  pollPairingResult,
  startPairingWatcher,
} from '../pairing-watch.ts';
import { browserQrRenderer, QR_RENDER_OPTIONS, renderPairingQr } from '../pairing-qr.ts';
import { parseConnectionPayload, PAIRING_LINK_PREFIX } from '../connection-payload.ts';

/**
 * Anchored to the real clock on purpose. The §5.1 validator rejects a payload
 * whose `expiresAt` has already passed, and it does so against `Date.now()` —
 * there is no clock seam there, because a spent pairing link must be refused
 * wherever it is read. A fixed date would therefore rot: this file passed on
 * 2026-09-19 and failed on 2026-09-20 with its code unchanged. Every fixture
 * timestamp below is derived from this anchor, so the watcher's own injected
 * clock and the validator's real one still agree.
 */
const NOW = Date.now();
const HOUR_LATER = new Date(NOW + 3_600_000).toISOString();

/** Faithful wire rows: the watcher is typed against the real shapes, so the
 * fixtures build full rows rather than casts. */
function pendingRow(id: string, overrides: Partial<PendingPairingRow> = {}): PendingPairingRow {
  return {
    id,
    label: 'Phone',
    createdAt: new Date(NOW).toISOString(),
    expiresAt: HOUR_LATER,
    usedAt: null,
    cancelledAt: null,
    clientId: null,
    fingerprint: 'C'.repeat(43),
    allowedClientKinds: ['mobile', 'desktop'],
    createdByClientId: null,
    usesRelay: false,
    ...overrides,
  };
}

function clientRow(id: string, overrides: Partial<RemoteClientRow> = {}): RemoteClientRow {
  return {
    id,
    label: 'Phone',
    createdAt: new Date(NOW).toISOString(),
    lastUsedAt: new Date(NOW).toISOString(),
    revokedAt: null,
    clientKind: 'mobile',
    usesRelay: false,
    lastTransport: 'direct',
    pairingId: 'p1',
    ...overrides,
  };
}

type StubRoute = { url: string; body?: unknown; status?: number };
type StubCall = { url: string; method: string; body: unknown };

/**
 * Route-ordered stub: every queued answer must match the URL actually asked,
 * so a client that hits the wrong endpoint (or the right one in the wrong
 * order) fails loudly instead of returning the wrong body.
 */
function stubRuntime(
  routes: StubRoute[],
  clock = NOW,
): { runtime: PairingRuntime; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const queue = [...routes];
  const fetch = async (input: string | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' && init.body !== '' ? JSON.parse(init.body) : undefined,
    });
    const next = queue.shift();
    if (next === undefined) throw new Error(`unexpected fetch ${url}`);
    if (next.url !== url) throw new Error(`expected ${next.url}, asked ${url}`);
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return {
    runtime: createPairingRuntime({
      fetch: fetch as unknown as PairingRuntime['fetch'],
      now: () => clock,
    }),
    calls,
  };
}

type RequestInit = { method?: string; body?: string; headers?: Record<string, string> };

const TRANSPORTS: PairingTransports = {
  local: 'http://127.0.0.1:3000',
  lan: 'http://192.168.1.20:3000',
  relayAvailable: true,
};

const CREATED_PAIRING = {
  id: 'pair_1',
  secret: 'aHdhZXNvbWV0aGlzZ3JlYXRzZWNyZXR2YWx1ZTEyMzQ1Njg',
  createdAt: new Date(NOW).toISOString(),
  expiresAt: HOUR_LATER,
  usedAt: null,
  cancelledAt: null,
  clientId: null,
  label: 'Phone',
  fingerprint: 'B'.repeat(43),
  allowedClientKinds: ['mobile', 'desktop'],
  createdByClientId: null,
  usesRelay: true,
};

const SERVER = {
  label: 'workstation',
  candidates: [
    { type: 'lan', url: 'http://192.168.1.20:3000', priority: 10 },
    {
      type: 'relay',
      relayUrl: 'wss://relay.example.test/ws',
      serverId: 'srv_1',
      hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'AAA', y: 'BBB' },
      grant: 'Z3JhbnRkZW1v',
      priority: 30,
    },
  ],
};

describe('planPairingRequest (doc 08 §6.1 step 2)', () => {
  it('maps "this computer only" to the loopback URL with no relay', () => {
    const plan = planPairingRequest('local', TRANSPORTS, 'Phone', false);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.body).toEqual({
      label: 'Phone',
      allowedClientKinds: ['mobile', 'desktop'],
      serverUrl: 'http://127.0.0.1:3000',
      includeRelay: false,
    });
  });

  it('an empty label keeps the stored label null so the redeem can fall back', () => {
    const plan = planPairingRequest('local', TRANSPORTS, '   ', false);
    expect(plan.ok && plan.body.label).toBe(null);
  });

  it('home network carries the LAN URL and the relay exactly when the checkbox consents', () => {
    const without = planPairingRequest('lan', TRANSPORTS, 'Tablet', false);
    expect(without.ok && without.body.includeRelay).toBe(false);
    const checked = planPairingRequest('lan', TRANSPORTS, 'Tablet', true);
    // §6.1 step 2: the checkbox is consent, and consent is includeRelay: true
    // — the route force-starts the relay host for that flag instead of leaving
    // a promised candidate out when the relay happens to be off.
    expect(checked.ok && checked.body).toEqual({
      label: 'Tablet',
      allowedClientKinds: ['mobile', 'desktop'],
      serverUrl: 'http://192.168.1.20:3000',
      includeRelay: true,
    });
  });

  it('anywhere without the fallback is a relay-only link', () => {
    const relayOnly = planPairingRequest('anywhere', TRANSPORTS, '', false);
    expect(relayOnly.ok && relayOnly.body).toEqual({
      label: null,
      allowedClientKinds: ['mobile', 'desktop'],
      includeRelay: true,
      includeDirect: false,
    });
  });

  it('anywhere with the fallback carries the home-network candidate too', () => {
    const both = planPairingRequest('anywhere', TRANSPORTS, '', true);
    expect(both.ok && both.body).toEqual({
      label: null,
      allowedClientKinds: ['mobile', 'desktop'],
      serverUrl: 'http://192.168.1.20:3000',
      includeRelay: true,
    });
  });

  it('anywhere with the fallback but no LAN URL stays relay-only', () => {
    const noLan = planPairingRequest('anywhere', { ...TRANSPORTS, lan: null }, '', true);
    expect(noLan.ok && noLan.body.includeRelay).toBe(true);
    expect(noLan.ok && noLan.body.includeDirect).toBe(false);
  });

  it('anywhere with the fallback still asks for the relay when the transports view cannot see it', () => {
    // 'Anywhere' is the relay scope; the server force-starts the relay for
    // includeRelay: true (§6.1 step 3), and a relay that truly cannot start
    // 503s as a create error — the transports view being blind right now is
    // no reason to silently issue a link that cannot work away from home.
    const lan = planPairingRequest('anywhere', { ...TRANSPORTS, relayAvailable: false }, 'Laptop', true);
    expect(lan.ok && lan.body).toEqual({
      label: 'Laptop',
      allowedClientKinds: ['mobile', 'desktop'],
      serverUrl: 'http://192.168.1.20:3000',
      includeRelay: true,
    });
    const noLan = planPairingRequest('anywhere', { ...TRANSPORTS, relayAvailable: false, lan: null }, '', true);
    expect(noLan.ok && noLan.body).toEqual({
      label: null,
      allowedClientKinds: ['mobile', 'desktop'],
      includeRelay: true,
      includeDirect: false,
    });
  });

  it('refuses a scope the server cannot serve', () => {
    expect(planPairingRequest('lan', { ...TRANSPORTS, lan: null }, '', false)).toEqual({
      ok: false,
      reason: 'no-lan',
    });
    expect(planPairingRequest('local', { ...TRANSPORTS, local: '' }, '', false)).toEqual({
      ok: false,
      reason: 'no-loopback',
    });
    // Fallback unchecked means the operator declined the relay; force-starting
    // a deliberately disabled relay would override them (E-08-52), so the
    // dialog refuses with guidance instead.
    expect(
      planPairingRequest('anywhere', { ...TRANSPORTS, relayAvailable: false }, '', false),
    ).toEqual({ ok: false, reason: 'relay-unavailable' });
  });
});

describe('createPairingLink (doc 08 §6.1 steps 3-4)', () => {
  it('posts the planned body and encodes the link from the server answer', async () => {
    const { runtime, calls } = stubRuntime([
      { url: '/api/client-auth/pairing/sessions', body: { pairing: CREATED_PAIRING, server: SERVER } },
    ]);
    const created = await createPairingLink(
      { scope: 'anywhere', transports: TRANSPORTS, label: 'Phone', relayFallback: false },
      runtime,
    );
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toEqual({
      label: 'Phone',
      allowedClientKinds: ['mobile', 'desktop'],
      includeRelay: true,
      includeDirect: false,
    });
    expect(created.link.startsWith(PAIRING_LINK_PREFIX)).toBe(true);
    const parsed = parseConnectionPayload(created.link);
    expect(parsed.status).toBe('pairing');
    if (parsed.status !== 'pairing') return;
    // §6.1 step 4: the device names its connection by the issuing machine.
    expect(parsed.payload.label).toBe('workstation');
    expect(parsed.payload.pairingId).toBe('pair_1');
    expect(parsed.payload.expiresAt).toBe(HOUR_LATER);
    expect(parsed.payload.candidates).toEqual(SERVER.candidates);
  });

  it('surfaces the server error text and status', async () => {
    const { runtime } = stubRuntime([
      {
        url: '/api/client-auth/pairing/sessions',
        status: 503,
        body: { error: 'Relay fallback requested but unavailable' },
      },
    ]);
    let failure: unknown = null;
    try {
      await createPairingLink(
        { scope: 'anywhere', transports: TRANSPORTS, label: '', relayFallback: true },
        runtime,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure instanceof PairingApiError).toBe(true);
    expect((failure as PairingApiError).status).toBe(503);
    expect((failure as PairingApiError).message).toContain('Relay fallback requested');
  });

  it('an unplannable scope never reaches the network', async () => {
    const { runtime, calls } = stubRuntime([]);
    await expect(createPairingLink(
      { scope: 'lan', transports: { ...TRANSPORTS, lan: null }, label: '', relayFallback: false },
      runtime,
    )).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe('pairing reads (doc 08 §6.1 steps 5, 9)', () => {
  it('normalizes the transport picture', async () => {
    const { runtime } = stubRuntime([
      {
        url: '/api/client-auth/pairing/transports',
        body: { local: 'http://127.0.0.1:3000', lan: '', relayAvailable: true },
      },
    ]);
    expect(await fetchPairingTransports(runtime)).toEqual({
      local: 'http://127.0.0.1:3000',
      lan: null,
      relayAvailable: true,
    });
  });

  it('reads the pending list and drops malformed rows', async () => {
    const row = {
      id: 'p1',
      label: 'Phone',
      createdAt: new Date(NOW).toISOString(),
      expiresAt: HOUR_LATER,
      usedAt: null,
      cancelledAt: null,
      clientId: null,
      fingerprint: 'C'.repeat(43),
      allowedClientKinds: ['mobile'],
      createdByClientId: null,
      usesRelay: false,
    };
    const { runtime } = stubRuntime([
      { url: '/api/client-auth/pairing/sessions', body: { pending: [row, { id: 2 }, null] } },
    ]);
    expect(await listPendingPairings(runtime)).toEqual([row]);
  });

  it('reads the device list', async () => {
    const { runtime } = stubRuntime([
      { url: '/api/client-auth/clients', body: { clients: [{ id: 'c1', pairingId: 'p1' }] } },
    ]);
    expect(await listRemoteClients(runtime)).toEqual([{ id: 'c1', pairingId: 'p1' }]);
  });

  it('reports a cancel by the server answer and escapes the id', async () => {
    const { runtime, calls } = stubRuntime([
      { url: '/api/client-auth/pairing/sessions/p%201', body: { cancelled: true } },
    ]);
    expect(await cancelPairingSession('p 1', runtime)).toBe(true);
    expect(calls[0]?.method).toBe('DELETE');
  });

  it('a 401 carries the route status for the auth gate to act on', async () => {
    const { runtime } = stubRuntime([
      { url: '/api/client-auth/pairing/transports', status: 401, body: { error: 'Unauthorized' } },
    ]);
    let failure: unknown = null;
    try {
      await fetchPairingTransports(runtime);
    } catch (error) {
      failure = error;
    }
    expect(failure instanceof PairingApiError).toBe(true);
    expect((failure as PairingApiError).status).toBe(401);
  });
});

describe('observePairingPoll (doc 08 §6.1 step 8)', () => {
  const listed = pendingRow('p1');

  it('does not close before it has seen the pairing pending', () => {
    const state = createPairingWatchState('p1', HOUR_LATER);
    observePairingPoll(state, { ok: true, pending: [], clients: [] }, NOW);
    expect(state.seenPending).toBe(false);
    expect(state.closed).toBeNull();
  });

  it('closes only after seeing it pending, then absent on a successful poll', () => {
    const state = createPairingWatchState('p1', HOUR_LATER);
    observePairingPoll(state, { ok: true, pending: [listed], clients: [] }, NOW);
    expect(state.seenPending).toBe(true);
    expect(state.closed).toBeNull();
    observePairingPoll(state, { ok: true, pending: [], clients: [clientRow('c1')] }, NOW);
    expect(state.closed).toBe('redeemed');
    expect(state.redeemed).toBe(true);
  });

  it('a failed poll neither blanks the signal nor fakes redemption', () => {
    const state = createPairingWatchState('p1', HOUR_LATER);
    observePairingPoll(state, { ok: true, pending: [listed], clients: [] }, NOW);
    observePairingPoll(state, { ok: false }, NOW);
    expect(state.closed).toBeNull();
    expect(state.seenPending).toBe(true);
  });

  it('a revoked device row is not a live connection', () => {
    const state = createPairingWatchState('p1', HOUR_LATER);
    observePairingPoll(state, { ok: true, pending: [listed], clients: [] }, NOW);
    observePairingPoll(
      state,
      { ok: true, pending: [], clients: [clientRow('c1', { revokedAt: new Date(NOW).toISOString() })] },
      NOW,
    );
    expect(state.redeemed).toBe(false);
    // Before the create-time expiry, an unexplained disappearance is a cancel.
    expect(state.closed).toBe('cancelled');
  });

  it('uses the create-time expiry to tell expired from cancelled', () => {
    const past = new Date(NOW - 1).toISOString();
    const state = createPairingWatchState('p1', past);
    observePairingPoll(state, { ok: true, pending: [listed], clients: [] }, NOW);
    observePairingPoll(state, { ok: true, pending: [], clients: [] }, NOW);
    expect(state.closed).toBe('expired');
    expect(state.redeemed).toBe(false);
  });

  it('a close is sticky', () => {
    const state = createPairingWatchState('p1', HOUR_LATER);
    observePairingPoll(state, { ok: true, pending: [listed], clients: [] }, NOW);
    observePairingPoll(state, { ok: true, pending: [], clients: [clientRow('c')] }, NOW);
    const closed = state.closed;
    observePairingPoll(state, { ok: true, pending: [listed], clients: [] }, NOW);
    expect(state.closed).toBe(closed);
  });
});

describe('pollPairingResult + startPairingWatcher (doc 08 §6.1 step 5)', () => {
  it('a throwing poll reports ok:false rather than blanking the list', async () => {
    const { runtime } = stubRuntime([
      { url: '/api/client-auth/pairing/sessions', status: 500, body: {} },
      { url: '/api/client-auth/clients', body: { clients: [] } },
    ]);
    const poll = await pollPairingResult('p1', runtime);
    expect(poll.ok).toBe(false);
    expect(poll.pending).toBeUndefined();
  });

  it('polls until the dialog may close', async () => {
    let ticks = 0;
    const fetch = async (input: string | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.url;
      const settled = ticks < 2;
      const body = url.includes('/pairing/sessions')
        ? { pending: settled ? [{ id: 'p1', expiresAt: HOUR_LATER }] : [] }
        : { clients: settled ? [] : [{ id: 'c1', pairingId: 'p1' }] };
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const runtime = createPairingRuntime({
      fetch: fetch as unknown as PairingRuntime['fetch'],
      now: () => NOW,
    });
    const watcher = startPairingWatcher('p1', HOUR_LATER, {
      runtime,
      intervalMs: 1,
      isVisible: () => true,
      sleep: async () => {
        ticks += 1;
      },
    });
    const final = await watcher.done;
    expect(final.closed).toBe('redeemed');
    expect(final.seenPending).toBe(true);
    expect(ticks).toBeGreaterThan(1);
  });

  it('does nothing while hidden and polls only once visible', async () => {
    let visible = false;
    let rounds = 0;
    const visibleAtPoll: boolean[] = [];
    const fetch = async (input: string | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.url;
      visibleAtPoll.push(visible);
      const settled = rounds >= 2;
      const body = url.includes('/pairing/sessions')
        ? { pending: settled ? [] : [{ id: 'p1', expiresAt: HOUR_LATER }] }
        : { clients: settled ? [{ id: 'c1', pairingId: 'p1' }] : [] };
      if (url.includes('/clients')) rounds += 1;
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const runtime = createPairingRuntime({
      fetch: fetch as unknown as PairingRuntime['fetch'],
      now: () => NOW,
    });
    const watcher = startPairingWatcher('p1', HOUR_LATER, {
      runtime,
      intervalMs: 1,
      isVisible: () => visible,
      sleep: async () => {
        visible = true;
      },
    });
    const final = await watcher.done;
    // §6.1 polls only while visible: not one of the many fetches may have
    // happened on the hidden first tick, and closing still took >1 round.
    expect(visibleAtPoll.length).toBeGreaterThan(0);
    expect(visibleAtPoll.every((seen) => seen)).toBe(true);
    expect(rounds).toBeGreaterThan(1);
    expect(final.closed).toBe('redeemed');
  });

  it('stop ends the loop without inventing a close reason', async () => {
    const { runtime } = stubRuntime([]);
    const watcher = startPairingWatcher('p1', HOUR_LATER, {
      runtime,
      intervalMs: 1,
      isVisible: () => false,
      sleep: async () => undefined,
    });
    watcher.stop();
    const final = await watcher.done;
    expect(final.closed).toBeNull();
  });
});

describe('renderPairingQr (doc 08 §5.8)', () => {
  it('renders exactly the link with the fixed options', async () => {
    const seen: Array<{ text: string; options: unknown }> = [];
    const outcome = await renderPairingQr('openchamber://connect?v=2&p=abc', async (text, options) => {
      seen.push({ text, options });
      return 'data:image/png;base64';
    });
    expect(outcome).toEqual({ ok: true, dataUrl: 'data:image/png;base64' });
    expect(seen[0]?.text).toBe('openchamber://connect?v=2&p=abc');
    expect(seen[0]?.options).toEqual(QR_RENDER_OPTIONS);
    expect(QR_RENDER_OPTIONS).toEqual({ width: 1024, margin: 2, errorCorrectionLevel: 'L' });
  });

  it('refuses an over-long link rather than an unscannable symbol', async () => {
    const outcome = await renderPairingQr('x'.repeat(3000), async () => 'data:');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.reason).toBe('too-large');
  });

  it('an unavailable renderer keeps the copyable-link path usable', async () => {
    const outcome = await renderPairingQr('openchamber://connect?v=2&p=abc', null);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.reason).toBe('render-failed');
  });

  it('a renderer that throws becomes a reason, never a crash', async () => {
    const outcome = await renderPairingQr('openchamber://connect?v=2&p=abc', async () => {
      throw new Error('canvas blocked');
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.message).toContain('canvas blocked');
  });

  it('the browser binding is a function backed by qrcode.toDataURL', async () => {
    const render = await browserQrRenderer();
    expect(typeof render).toBe('function');
  });
});
