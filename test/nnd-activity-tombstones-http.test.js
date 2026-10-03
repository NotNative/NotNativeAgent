// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NndEngineHost } from '../src/nnd-engine-host.js';
import { NndActivityTombstones, TOMBSTONE_LIMIT } from '../src/nnd-activity-tombstones.js';
import { persistAtomicJson } from '../src/persistence/atomic-json.js';
import { startIntegrationServer } from '../src/integration-server.js';
import { createNndLocalIntegrationActivation } from '../src/nno-integration-activation.js';

const token = 'test-tombstone-http-token-with-at-least-32-characters';
const owner = { subjectId: 'operator', workspaceIds: ['primary'] };
const actor = (subject = 'operator', workspaces = ['primary'], permissions = ['nnd.read']) => ({
  subject_id: subject, platform_role: 'user', permissions, workspace_ids: workspaces,
  group_ids: [], trace_id: 'activity_tombstones', request_id: 'tombstone_page', issued_at: new Date().toISOString(),
});
const engine = () => ({ config: { executionManifest: null }, async initialize() {}, async shutdown() {} });
const route = '/v1/nnd/activity-tombstones';

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nna-tombstone-http-'));
  const catalogPath = join(root, 'catalog.json');
  const host = new NndEngineHost({ catalogPath, createEngine: async () => engine(), ...options });
  const service = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(),
    token, nndEngineHost: host, port: 0 });
  t.after(async () => { await service.close(); await host.shutdown(); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${service.address.port}`;
  return { root, catalogPath, host, base };
}

async function request(base, path = route, principal = actor(), method = 'GET') {
  const response = await fetch(base + path, { method, redirect: 'error', headers: {
    authorization: `Bearer ${token}`,
    'x-nna-principal': Buffer.from(JSON.stringify(principal)).toString('base64url'),
  } });
  return { status: response.status, body: await response.json() };
}

test('HTTP recovers a catalog-committed deletion after journal finalization fails', async t => {
  let writes = 0;
  const f = await fixture(t, { persistTombstones: async (path, value) => {
    if (++writes === 2) throw Error('journal finalization interrupted');
    await persistAtomicJson(path, value);
  } });
  await f.host.create('session_a', owner);
  await assert.rejects(f.host.close('session_a', owner), /journal finalization interrupted/u);
  const reopened = new NndEngineHost({ catalogPath: f.catalogPath, createEngine: async () => engine() });
  await reopened.initialize();
  const service = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(),
    token, nndEngineHost: reopened, port: 0 });
  t.after(async () => { await service.close(); await reopened.shutdown(); });
  const recovered = await request(`http://127.0.0.1:${service.address.port}`);
  assert.equal(recovered.status, 200);
  assert.deepEqual(recovered.body.records.map((item) => item.sessionID), ['session_a']);
  assert.equal(recovered.body.historyComplete, false);
});

test('HTTP deletion page is authenticated, owner-scoped, bounded and survives restart', async t => {
  const f = await fixture(t);
  await f.host.create('session_a', owner);
  const createdAt = f.host.get('session_a', owner).time.created;
  await f.host.close('session_a', owner);
  const page = await request(f.base);
  assert.equal(page.status, 200);
  assert.deepEqual(page.body.records.map(({ sessionID, createdAt: at, kind }) => [sessionID, at, kind]),
    [['session_a', createdAt, 'deleted']]);
  assert.equal(page.body.historyComplete, false);
  assert.equal(page.body.nextCursor, 1);
  assert.equal((await request(f.base, route + '?after=1')).body.records.length, 0);
  assert.equal((await fetch(f.base + route)).status, 401);
  assert.equal((await request(f.base, route, actor('operator', ['primary'], []))).status, 403);
  assert.deepEqual((await request(f.base, route, actor('other'))).body.records, []);
  assert.deepEqual((await request(f.base, route, actor('operator', ['primary', 'second']))).body.records, []);
  for (const query of ['?after=-1', '?after=01', '?after=9007199254740992', '?after=1&after=2',
    '?limit=0', '?limit=101', '?limit=1&limit=2', '?sessionID=session_a']) {
    assert.equal((await request(f.base, route + query)).status, 400, query);
  }
  assert.equal((await request(f.base, route, actor(), 'POST')).status, 405);
  const reopened = new NndEngineHost({ catalogPath: f.catalogPath, createEngine: async () => engine() });
  await reopened.initialize();
  const service = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(),
    token, nndEngineHost: reopened, port: 0 });
  t.after(async () => { await service.close(); await reopened.shutdown(); });
  const resumed = await request(`http://127.0.0.1:${service.address.port}`);
  assert.deepEqual(resumed.body.records, page.body.records);
});

test('HTTP page reports truncation floor and never promises complete deletion history', async t => {
  const f = await fixture(t);
  const journal = new NndActivityTombstones(f.catalogPath);
  for (let index = 0; index <= TOMBSTONE_LIMIT; index++) {
    const context = { sessionId: `session_${index}`, createdAt: index + 1,
      subjectId: owner.subjectId, workspaceIds: new Set(owner.workspaceIds) };
    const sequence = await journal.prepare(context);
    await journal.committed(context, sequence);
  }
  const gap = await request(f.base, route + '?after=0');
  assert.deepEqual({ status: gap.status, result: gap.body.status, floor: gap.body.floor,
    nextCursor: gap.body.nextCursor, historyComplete: gap.body.historyComplete },
  { status: 200, result: 'gap', floor: 1, nextCursor: null, historyComplete: false });
  const page = await request(f.base, route + '?after=1&limit=100');
  assert.equal(page.body.records.length, 100);
  assert.equal(page.body.records[0].sequence, 2);
  assert.equal(page.body.historyComplete, false);
});

test('corrupt owner journal fails closed without a deletion page', async t => {
  const f = await fixture(t);
  const journal = new NndActivityTombstones(f.catalogPath);
  const context = { sessionId: 'session_a', createdAt: 1,
    subjectId: owner.subjectId, workspaceIds: new Set(owner.workspaceIds) };
  const sequence = await journal.prepare(context);
  await journal.committed(context, sequence);
  const directory = `${f.catalogPath}.tombstones`;
  const [name] = await readdir(directory);
  await writeFile(join(directory, name), '{corrupt');
  const result = await request(f.base);
  assert.equal(result.status, 500);
  assert.equal(result.body.error.code, 'nnd_activity_tombstones_invalid');
  assert.equal(result.body.error.message, 'integration request failed');
});

test('missing middle or last deletion sequence fails closed instead of returning a partial page', async t => {
  const f = await fixture(t);
  const journal = new NndActivityTombstones(f.catalogPath);
  for (let index = 0; index < 3; index++) {
    const context = { sessionId: `session_${index}`, createdAt: index + 1,
      subjectId: owner.subjectId, workspaceIds: new Set(owner.workspaceIds) };
    const sequence = await journal.prepare(context);
    await journal.committed(context, sequence);
  }
  const directory = `${f.catalogPath}.tombstones`;
  const [name] = await readdir(directory);
  const path = join(directory, name);
  const original = JSON.parse(await readFile(path, 'utf8'));
  for (const missing of [2, 3]) {
    await writeFile(path, JSON.stringify({ ...original,
      entries: original.entries.filter((entry) => entry.sequence !== missing) }));
    const result = await request(f.base);
    assert.equal(result.status, 500);
    assert.equal(result.body.error.code, 'nnd_activity_tombstones_invalid');
  }
});
