// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveManifest } from '../src/config.js';
import { startOpencodeServe } from '../src/opencode/serve.js';
import { basicAuthorization } from '../src/opencode/protocol.js';
import { WIRED_OPENCODE_VERSION } from '../src/opencode/version.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixtureConfig() {
  return resolveManifest({
    persistence: 'ephemeral',
    provider: { id: 'test', endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture-model', trust_zone: 'loopback' },
  });
}

function fixtureRoot() { return mkdtemp(join(tmpdir(), 'nna-opencode-')); }

async function serveDuring(options, run) {
  const handshake = [];
  const runtime = await startOpencodeServe({ ...options, stdout: { write: () => undefined }, handshakeSink: async (line) => handshake.push(line) });
  try { return await run({ runtime, url: runtime.url, handshake }); }
  finally { await runtime.stop(); }
}

function request(url, path, options = {}) {
  return fetch(`${url}${path}`, { connection: 'close', ...options, headers: { connection: 'close', ...(options.headers ?? {}) } });
}

test('serve emits the exact OpenCode handshake line with the bound port', async () => {
  await serveDuring({ config: fixtureConfig(), storeRoot: join(await fixtureRoot(), 's'), reviewerRoot: join(await fixtureRoot(), 'r') }, async ({ handshake, url }) => {
    assert.equal(handshake.length, 1);
    assert.match(handshake[0], /^opencode server listening on http:\/\/127\.0\.0\.1:\d+$/u);
    assert.match(url, /^http:\/\/127\.0\.0\.1:/u);
  });
});

test('health, auth gate, and 404 catch-all match the observed gold wire', async () => {
  await serveDuring({ config: fixtureConfig(), password: 'bench-pw', storeRoot: join(await fixtureRoot(), 's'), reviewerRoot: join(await fixtureRoot(), 'r') }, async ({ url }) => {
    const denied = await request(url, '/global/health');
    assert.equal(denied.status, 401);
    assert.equal((await denied.text()).length, 0);
    const auth = { authorization: basicAuthorization('opencode', 'bench-pw') };
    const health = await (await request(url, '/global/health', { headers: auth })).json();
    assert.deepEqual(health, { healthy: true, version: WIRED_OPENCODE_VERSION });
    const missing = await request(url, '/definitely/not/a/route', { headers: auth });
    assert.equal(missing.status, 404);
    assert.equal((await missing.text()).length, 0);
    const wrongPassword = await request(url, '/global/health', { headers: { authorization: basicAuthorization('opencode', 'nope') } });
    assert.equal(wrongPassword.status, 401);
    assert.equal(WIRED_OPENCODE_VERSION, '1.18.31');
  });
});

test('session lifecycle speaks the gold Session shape', async () => {
  await serveDuring({ config: fixtureConfig(), storeRoot: join(await fixtureRoot(), 's'), reviewerRoot: join(await fixtureRoot(), 'r'), directory: 'D:\\fixture-dir' }, async ({ url }) => {
    const empty = await (await request(url, '/session')).json();
    assert.deepEqual(empty, []);
    const createdResponse = await request(url, '/session', { method: 'POST', body: JSON.stringify({ title: 'bench' }) });
    assert.equal(createdResponse.status, 200);
    const created = await createdResponse.json();
    assert.match(created.id, /^ses_[A-Za-z0-9-]+$/u);
    assert.deepEqual(Object.keys(created).sort(), ['cost', 'directory', 'id', 'path', 'projectID', 'slug', 'time', 'title', 'tokens', 'version']);
    assert.equal(created.directory, 'D:\\fixture-dir');
    assert.match(created.projectID, /^[0-9a-f]{40}$/u);
    assert.equal(created.title, 'bench');
    assert.deepEqual(Object.keys(created.time).sort(), ['created', 'updated']);
    assert.deepEqual(Object.keys(created.tokens).sort(), ['cache', 'input', 'output', 'reasoning']);
    assert.equal(created.path, '');
    const fetched = await (await request(url, `/session/${created.id}`)).json();
    assert.equal(fetched.id, created.id);
    const refreshed = await (await request(url, `/session/${created.id}/message`)).json();
    assert.deepEqual(refreshed, []);
    const listing = await (await request(url, '/session')).json();
    assert.equal(listing.length, 1);
    const removed = await request(url, `/session/${created.id}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    const afterDelete = await request(url, `/session/${created.id}`);
    assert.equal(afterDelete.status, 404);
    assert.equal((await afterDelete.text()).length, 0);
    const finalList = await (await request(url, '/session')).json();
    assert.deepEqual(finalList, []);
  });
});

test('diagnostics ring records wire traffic for drift investigation', async () => {
  await serveDuring({ config: fixtureConfig(), storeRoot: join(await fixtureRoot(), 's'), reviewerRoot: join(await fixtureRoot(), 'r') }, async ({ url }) => {
    await request(url, '/global/health');
    await request(url, '/no/such/route');
    const diagnostics = await (await request(url, '/__nna/diagnostics')).json();
    assert.equal(diagnostics.version, WIRED_OPENCODE_VERSION);
    assert.ok(diagnostics.requests >= 2);
    assert.equal(diagnostics.errors >= 1, true);
    assert.ok(diagnostics.ring.some((entry) => entry.url === '/no/such/route' && entry.status === 404));
    assert.ok(diagnostics.sessions !== null);
  });
});

test('surface stop shuts down every live session engine, not just the listener', async () => {
  // Why: runtime.stop() must dispose wired sessions through the same engine
  // shutdown the wire's DELETE route uses; skipping it leaves the per-session
  // resources (telemetry worker, journal store) running past the surface stop.
  const storeRoot = join(await fixtureRoot(), 's');
  const reviewerRoot = join(await fixtureRoot(), 'r');
  await serveDuring({ config: fixtureConfig(), storeRoot, reviewerRoot }, async ({ runtime, url }) => {
    const created = await (await request(url, '/session', {
      method: 'POST', body: JSON.stringify({ title: 'stop-drain' }),
    })).json();
    assert.match(created.id, /^ses_[A-Za-z0-9-]+$/u);
    const engine = runtime.workspace.registry.get(created.id)?.engine ?? null;
    assert.ok(engine, 'created session must expose its live engine');
    await runtime.stop();
    assert.equal(runtime.closed, true);
    assert.equal(runtime.workspace.registry.count(), 0);
    assert.equal(engine.state.state, 'shutting_down');
  });
});
