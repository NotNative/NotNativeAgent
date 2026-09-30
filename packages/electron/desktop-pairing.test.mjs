// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopPairingImporter } from './desktop-pairing.mjs';

const payload = (overrides = {}) => ({
  v: 2, pairingId: 'pair-1', secret: 'short-lived-secret',
  expiresAt: new Date(Date.now() + 60_000).toISOString(), label: 'Studio',
  candidates: [
    { type: 'lan', url: 'http://192.168.1.20:57123', priority: 10 },
    { type: 'tunnel', url: 'https://studio.example/nnd', priority: 20 },
  ],
  ...overrides,
});

function setup({ dialogResponses = [0], fetchImpl, hosts = [], now, redeemRelay } = {}) {
  const dialogs = [];
  const writes = [];
  const calls = [];
  const importer = createDesktopPairingImporter({
    dialog: { showMessageBox: async (_window, options) => { dialogs.push(options); return { response: dialogResponses.shift() ?? 0 }; } },
    getWindow: () => ({ isDestroyed: () => false }),
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (fetchImpl) return fetchImpl(url, options);
      if (url.endsWith('/health')) return Response.json({ ok: true });
      return Response.json({ ok: true, clientToken: 'nnd_client_token', server: { label: 'Studio Server' } });
    },
    getHosts: () => ({ hosts, defaultHostId: null, initialHostChoiceCompleted: false }),
    setHosts: (config) => { writes.push(config); return config; },
    getInstallId: () => '0c21f7cb-f35f-4100-8da5-26e588998012',
    platform: 'win32', version: '20260930.0.41', makeHostId: () => 'host-new',
    ...(redeemRelay ? { redeemRelay } : {}),
    ...(now ? { now } : {}),
  });
  return { importer, dialogs, writes, calls };
}

test('relay-only pairing consents, redeems through the local relay bridge, and never persists the grant', async () => {
  const relayCandidate = {
    type: 'relay', relayUrl: 'wss://relay.example/ws', serverId: 'relay-server',
    hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'pub-x', y: 'pub-y' }, grant: 'one-time-grant',
  };
  const pairing = payload({ candidates: [relayCandidate] });
  let locked = false;
  const hosts = [];
  const redeemed = [];
  const dialogs = [];
  const writes = [];
  const importer = createDesktopPairingImporter({
    dialog: { showMessageBox: async (...args) => { dialogs.push(args.at(-1)); return { response: 0 }; } },
    getWindow: () => null, fetch: async () => { throw new Error('direct fetch must not be used'); },
    getHosts: () => ({ hosts, defaultHostId: null, initialHostChoiceCompleted: false }),
    setHosts: (config) => { hosts.splice(0, hosts.length, ...config.hosts); writes.push(config); return config; },
    getInstallId: () => 'install-id', platform: 'win32', version: '20260930.0.49', makeHostId: () => 'relay-host',
    redeemRelay: async (input) => {
      assert.equal(locked, true);
      redeemed.push(input);
      return { ok: true, clientToken: 'relay-client-token', serverLabel: 'Relay Studio' };
    },
    acquireHostConfigLock: () => { if (locked) return null; locked = true; return () => { locked = false; }; },
  });
  assert.deepEqual(await importer.importPairing(pairing), {
    status: 'paired', hostId: 'relay-host', url: 'relay://relay-server',
  });
  assert.equal(redeemed.length, 1);
  assert.equal(redeemed[0].payload, pairing);
  assert.equal(redeemed[0].candidate, relayCandidate);
  assert.deepEqual({ installId: redeemed[0].installId, platform: redeemed[0].platform, version: redeemed[0].version }, {
    installId: 'install-id', platform: 'win32', version: '20260930.0.49',
  });
  assert.equal(locked, false);
  assert.deepEqual(hosts[0], {
    id: 'relay-host', label: 'Studio', url: 'relay://relay-server',
    clientToken: 'relay-client-token', serverId: 'relay-server',
    relay: { relayUrl: relayCandidate.relayUrl, serverId: relayCandidate.serverId, hostEncPubJwk: relayCandidate.hostEncPubJwk },
  });
  assert.equal(JSON.stringify(hosts).includes('one-time-grant'), false);
  assert.equal(dialogs[0].buttons[0], 'Connect');
  assert.match(dialogs[0].detail, /relay\.example/u);
  assert.equal(writes.length, 1);
});

test('relay-only pairing cancellation does not ask the renderer to redeem or mutate hosts', async () => {
  const redeemRelay = async () => { throw new Error('must not run'); };
  const state = setup({ dialogResponses: [1], redeemRelay });
  const result = await state.importer.importPairing(payload({ candidates: [{
    type: 'relay', relayUrl: 'wss://relay.example/ws', serverId: 'relay-server',
    hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'pub-x', y: 'pub-y' }, grant: 'grant',
  }] }));
  assert.deepEqual(result, { status: 'cancelled' });
  assert.equal(state.writes.length, 0);
});

test('relay-only pairing reports server rate limits as try again later', async () => {
  const pairing = payload({ candidates: [{
    type: 'relay', relayUrl: 'wss://relay.example/ws', serverId: 'relay-server',
    hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'pub-x', y: 'pub-y' }, grant: 'grant',
  }] });
  const state = setup({ redeemRelay: async () => ({ ok: false, error: 'pairing-rate-limited' }) });
  assert.deepEqual(await state.importer.importPairing(pairing), { status: 'relay-redeem-failed' });
  assert.equal(state.dialogs[1].title, 'Try again later');
  assert.match(state.dialogs[1].message, /Try again later/u);
  assert.equal(state.writes.length, 0);
});

test('cancelling native consent makes no network request and persists nothing', async () => {
  const state = setup({ dialogResponses: [1] });
  const pairing = payload({ candidates: [
    { type: 'lan', url: 'http://192.168.1.20:57123?opaque=private-query-value' },
    { type: 'tunnel', url: 'https://studio.example/nnd' },
  ] });
  assert.deepEqual(await state.importer.importPairing(pairing), { status: 'cancelled' });
  assert.equal(state.dialogs[0].defaultId, 1);
  assert.equal(state.dialogs[0].cancelId, 1);
  assert.match(state.dialogs[0].detail, /192\.168\.1\.20/u);
  assert.match(state.dialogs[0].detail, /%5Bredacted%5D/u);
  assert.doesNotMatch(state.dialogs[0].detail, /private-query-value/u);
  assert.match(state.dialogs[0].detail, /studio\.example/u);
  assert.match(state.dialogs[0].detail, /pairing secret/u);
  assert.equal(state.calls.length, 0);
  assert.equal(state.writes.length, 0);
});

test('same one-time pairing ID cannot bypass the in-flight guard with a changed expiry', async () => {
  let releaseConsent;
  const dialogs = [];
  const importer = createDesktopPairingImporter({
    dialog: { showMessageBox: async (_window, options) => {
      dialogs.push(options);
      if (dialogs.length === 1) return new Promise((resolve) => { releaseConsent = resolve; });
      return { response: 0 };
    } },
    getWindow: () => null,
    fetch: async (url) => url.endsWith('/health')
      ? Response.json({ ok: true }) : Response.json({ ok: true, clientToken: 'token' }),
    getHosts: () => ({ hosts: [], defaultHostId: null, initialHostChoiceCompleted: false }),
    setHosts: () => {}, getInstallId: () => '0c21f7cb-f35f-4100-8da5-26e588998012',
  });
  const first = importer.importPairing(payload());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await importer.importPairing(payload({ expiresAt: new Date(Date.now() + 90_000).toISOString() })), { status: 'already-processing' });
  releaseConsent({ response: 1 });
  assert.deepEqual(await first, { status: 'cancelled' });
  assert.equal(dialogs.length, 1);
});

test('serializes separate pairing imports so concurrent links cannot overfill the host catalog', async () => {
  const hosts = Array.from({ length: 99 }, (_, index) => ({ id: `saved-${index}`, url: `https://saved-${index}.example` }));
  const writes = [];
  const dialogs = [];
  const importer = createDesktopPairingImporter({
    dialog: { showMessageBox: async (_window, options) => { dialogs.push(options); return { response: 0 }; } },
    getWindow: () => null,
    fetch: async (url) => url.endsWith('/health')
      ? Response.json({ ok: true }) : Response.json({ ok: true, clientToken: 'token' }),
    getHosts: () => ({ hosts, defaultHostId: null, initialHostChoiceCompleted: false }),
    setHosts: (config) => { hosts.splice(0, hosts.length, ...config.hosts); writes.push(config); },
    getInstallId: () => '0c21f7cb-f35f-4100-8da5-26e588998012', makeHostId: (() => { let id = 0; return () => `host-new-${++id}`; })(),
  });
  const first = importer.importPairing(payload());
  const second = importer.importPairing(payload({ pairingId: 'pair-2', candidates: [{ type: 'lan', url: 'https://other.example' }] }));
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((result) => result.status), ['paired', 'catalog-full']);
  assert.equal(writes.length, 1);
  assert.equal(hosts.length, 100);
  assert.equal(dialogs.length, 3);
});

test('holds the host catalog lock through one-time redemption and persistence', async () => {
  let locked = false;
  let setterAttempt;
  const protectedImporter = createDesktopPairingImporter({
    dialog: { showMessageBox: async () => ({ response: 0 }) }, getWindow: () => null,
    fetch: async (url) => {
      if (url.endsWith('/health')) return Response.json({ ok: true });
      setterAttempt = locked ? { ok: false, error: 'desktop-hosts-busy' } : { ok: true };
      return Response.json({ ok: true, clientToken: 'nnd_client_token' });
    },
    getHosts: () => ({ hosts: [], defaultHostId: null, initialHostChoiceCompleted: false }), setHosts: () => {},
    getInstallId: () => '0c21f7cb-f35f-4100-8da5-26e588998012',
    acquireHostConfigLock: () => { if (locked) return null; locked = true; return () => { locked = false; }; },
  });
  await protectedImporter.importPairing(payload());
  assert.deepEqual(setterAttempt, { ok: false, error: 'desktop-hosts-busy' });
  assert.equal(locked, false);
});

test('probes in priority order, redeems once, and persists only after native consent', async () => {
  const state = setup({ fetchImpl: async (url, options) => {
      if (url.endsWith('/health')) {
        assert.equal(options.redirect, 'error');
        if (url.startsWith('http://192.168.1.20')) return new Response('unreachable', { status: 503 });
      return Response.json({ ok: true, serverId: 'stable-server-id' });
    }
    return Response.json({ ok: true, clientToken: 'nnd_client_token', server: { label: 'Studio Server' } });
  } });
  const result = await state.importer.importPairing(payload({ candidates: [
    ...payload().candidates,
    { type: 'relay', serverId: 'stable-server-id' },
  ] }));
  assert.deepEqual(result, { status: 'paired', hostId: 'host-new', url: 'https://studio.example/nnd' });
  assert.deepEqual(state.calls.map((call) => call.url), [
    'http://192.168.1.20:57123/health',
    'https://studio.example/nnd/health',
    'https://studio.example/nnd/api/client-auth/pairing/redeem',
  ]);
  const redeem = JSON.parse(state.calls[2].options.body);
  assert.equal(state.calls[2].options.redirect, 'error');
  assert.deepEqual(redeem, {
    pairingId: 'pair-1', secret: 'short-lived-secret', clientLabel: 'NotNativeDesktop',
    clientKind: 'desktop', deviceName: 'NotNativeDesktop', devicePlatform: 'win32',
    appVersion: '20260930.0.41', dedupeKey: 'desktop:0c21f7cb-f35f-4100-8da5-26e588998012',
  });
  assert.equal(state.writes.length, 1);
  assert.equal(state.writes[0].defaultHostId, 'host-new');
  assert.equal(state.writes[0].hosts[0].clientToken, 'nnd_client_token');
  assert.equal(state.writes[0].hosts[0].serverId, 'stable-server-id');
  assert.equal(state.dialogs.length, 2);
  assert.doesNotMatch(JSON.stringify(state.dialogs), /nnd_client_token|short-lived-secret/u);
});

test('pairing identity must match before the one-time secret is sent to a direct address', async (t) => {
  for (const health of [{ ok: true }, { ok: true, serverId: 'different-server' }]) {
    await t.test(JSON.stringify(health), async () => {
      const state = setup({ fetchImpl: async (url) => url.endsWith('/health')
        ? Response.json(health)
        : Response.json({ ok: true, clientToken: 'nnd_client_token' }) });
      const result = await state.importer.importPairing(payload({
        candidates: [
          { type: 'lan', url: 'https://studio.example' },
          { type: 'relay', serverId: 'expected-server' },
        ],
      }));
      assert.equal(result.status, 'unreachable');
      assert.equal(state.calls.some((call) => call.url.endsWith('/pairing/redeem')), false);
      assert.equal(state.writes.length, 0);
    });
  }
});

test('expired links, probe failures, invalid tokens, and full catalogs never persist a host', async (t) => {
  await t.test('expired link', async () => {
    const state = setup();
    assert.deepEqual(await state.importer.importPairing(payload({ expiresAt: new Date(Date.now() - 1_000).toISOString() })), { status: 'expired' });
    assert.equal(state.calls.length, 0);
  });
  await t.test('no healthy candidate', async () => {
    const state = setup({ fetchImpl: async () => new Response('down', { status: 503 }) });
    assert.deepEqual(await state.importer.importPairing(payload()), { status: 'unreachable' });
    assert.equal(state.writes.length, 0);
  });
  await t.test('link that expires during candidate probing is not redeemed', async () => {
    let clock = Date.now();
    const state = setup({ now: () => clock, fetchImpl: async (url) => {
      if (url.endsWith('/health')) {
        clock += 60_000;
        return Response.json({ ok: true });
      }
      return Response.json({ ok: true, clientToken: 'nnd_client_token' });
    } });
    const expiresAt = new Date(clock + 30_000).toISOString();
    assert.deepEqual(await state.importer.importPairing(payload({ expiresAt })), { status: 'expired' });
    assert.equal(state.calls.some((call) => call.url.endsWith('/pairing/redeem')), false);
    assert.equal(state.writes.length, 0);
  });
  await t.test('invalid token', async () => {
    const state = setup({ fetchImpl: async (url) => url.endsWith('/health')
      ? Response.json({ ok: true }) : Response.json({ ok: true, clientToken: 'bad\ntoken' }) });
    assert.deepEqual(await state.importer.importPairing(payload()), { status: 'redeem-rejected' });
    assert.equal(state.writes.length, 0);
  });
  await t.test('catalog full', async () => {
    const hosts = Array.from({ length: 100 }, (_, index) => ({ id: `host-${index}`, url: `https://host-${index}.example` }));
    const state = setup({ hosts });
    assert.deepEqual(await state.importer.importPairing(payload()), { status: 'catalog-full' });
    assert.equal(state.writes.length, 0);
    assert.equal(state.calls.some((call) => call.url.endsWith('/pairing/redeem')), false);
  });
});
