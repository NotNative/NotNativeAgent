// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NndEngineHost } from '../src/nnd-engine-host.js';
import { NndActivityTombstones, TOMBSTONE_LIMIT } from '../src/nnd-activity-tombstones.js';
import { activityPath } from '../src/nnd-activity-snapshot.js';
import { persistAtomicJson } from '../src/persistence/atomic-json.js';

const owner = { subjectId: 'operator', workspaceIds: ['primary'] };
const engine = () => ({ config: { executionManifest: null }, async initialize() {}, async shutdown() {} });
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nna-tombstones-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalogPath = join(root, 'catalog.json');
  const host = new NndEngineHost({ catalogPath, createEngine: async () => engine(), ...options });
  await host.create('session_a', owner);
  return { root, catalogPath, host };
}

test('committed deletion survives restart and only the exact owner can read its bounded receipt', async t => {
  const f = await fixture(t);
  const createdAt = f.host.get('session_a', owner).time.created;
  await f.host.close('session_a', owner);
  const page = await f.host.activityTombstonesPage(owner);
  assert.deepEqual(page.records, [{ sequence: 1, sessionID: 'session_a', createdAt,
    deletedAt: page.records[0].deletedAt, kind: 'deleted' }]);
  assert.equal(page.status, 'page'); assert.equal(page.historyComplete, false);
  assert.deepEqual((await f.host.activityTombstonesPage({ ...owner, subjectId: 'other' })).records, []);
  assert.deepEqual((await f.host.activityTombstonesPage({ ...owner, workspaceIds: ['primary', 'second'] })).records, []);
  await f.host.shutdown();
  const reopened = new NndEngineHost({ catalogPath: f.catalogPath, createEngine: async () => engine() });
  await reopened.initialize();
  assert.deepEqual((await reopened.activityTombstonesPage(owner)).records, page.records);
  await reopened.shutdown();
});

test('intent written before failed catalog delete is never a false deletion', async t => {
  const f = await fixture(t, { persistCatalog: async (path, records) => {
    if (records.length === 0) throw new Error('catalog write failed');
    await persistAtomicJson(path, records);
  } });
  await assert.rejects(f.host.close('session_a', owner), /catalog write failed/u);
  assert.equal((await f.host.activityTombstonesPage(owner)).records.length, 0);
  const reopened = new NndEngineHost({ catalogPath: f.catalogPath, createEngine: async () => engine() });
  await reopened.initialize();
  assert.equal(reopened.get('session_a', owner).id, 'session_a');
  assert.equal((await reopened.activityTombstonesPage(owner)).records.length, 0);
  await reopened.shutdown();
});

test('failed intent persistence cannot delete the catalog session', async t => {
  const f = await fixture(t, { persistTombstones: async () => { throw new Error('journal unavailable'); } });
  await assert.rejects(f.host.close('session_a', owner), /journal unavailable/u);
  assert.equal(JSON.parse(await readFile(f.catalogPath, 'utf8')).length, 1);
  assert.equal(f.host.get('session_a', owner).id, 'session_a');
  const reopened = new NndEngineHost({ catalogPath: f.catalogPath, createEngine: async () => engine() });
  await reopened.initialize();
  assert.equal(reopened.get('session_a', owner).id, 'session_a');
  await reopened.shutdown();
});

test('a transient intent write failure leaves the live session usable and retryable', async t => {
  let writes = 0;
  const f = await fixture(t, { persistTombstones: async (path, value) => {
    if (++writes === 1) throw new Error('temporary journal failure');
    await persistAtomicJson(path, value);
  } });
  await assert.rejects(f.host.close('session_a', owner), /temporary journal failure/u);
  assert.equal(f.host.get('session_a', owner).id, 'session_a');
  assert.deepEqual((await f.host.activityTombstonesPage(owner)).records, []);
  await f.host.close('session_a', owner);
  assert.equal((await f.host.activityTombstonesPage(owner)).records.length, 1);
  await f.host.shutdown();
});

test('a concurrent close cannot race the failed intent cleanup', async t => {
  let rejectWrite; let enteredWrite;
  const writing = new Promise(resolve => { enteredWrite = resolve; });
  const f = await fixture(t, { persistTombstones: async () => {
    enteredWrite();
    await new Promise((_, reject) => { rejectWrite = reject; });
  } });
  const first = f.host.close('session_a', owner);
  await writing;
  await assert.rejects(f.host.close('session_a', owner), { code: 'nnd_session_unavailable' });
  rejectWrite(new Error('intent failed'));
  await assert.rejects(first, /intent failed/u);
  assert.equal(f.host.get('session_a', owner).id, 'session_a');
  await f.host.shutdown();
});

test('concurrent deletes retain both owner receipts through serialized journal writes', async t => {
  const f = await fixture(t);
  await f.host.create('session_b', owner);
  await Promise.all([f.host.close('session_a', owner), f.host.close('session_b', owner)]);
  const page = await f.host.activityTombstonesPage(owner);
  assert.deepEqual(page.records.map((entry) => entry.sessionID), ['session_a', 'session_b']);
  assert.deepEqual(page.records.map((entry) => entry.sequence), [1, 2]);
  await f.host.shutdown();
});

test('catalog deletion committed before journal finalization remains recoverable after crash', async t => {
  let writes = 0;
  const f = await fixture(t, { persistTombstones: async (path, value) => {
    if (++writes === 2) throw new Error('journal finalization failed');
    await persistAtomicJson(path, value);
  } });
  await assert.rejects(f.host.close('session_a', owner), /journal finalization failed/u);
  assert.deepEqual(JSON.parse(await readFile(f.catalogPath, 'utf8')), []);
  const reopened = new NndEngineHost({ catalogPath: f.catalogPath, createEngine: async () => engine() });
  await reopened.initialize();
  assert.equal((await reopened.activityTombstonesPage(owner)).records[0].sessionID, 'session_a');
  await reopened.create('session_a', owner);
  assert.equal((await reopened.activityTombstonesPage(owner)).records[0].sessionID, 'session_a');
  await reopened.shutdown();
});

test('same-ID recreation cannot show old Activity when a crash left its file and the clock repeats', async t => {
  const f = await fixture(t);
  const createdAt = f.host.get('session_a', owner).time.created;
  await f.host.close('session_a', owner);
  await persistAtomicJson(activityPath(f.catalogPath, 'session_a'), { version: 1,
    sessionId: 'session_a', createdAt, records: [{ id: 'old_event', sessionID: 'session_a',
      time: createdAt, kind: 'notice', status: 'completed', summary: 'prior incarnation' }] });
  const originalNow = Date.now;
  try {
    Date.now = () => createdAt;
    await f.host.create('session_a', owner);
  } finally { Date.now = originalNow; }
  assert.deepEqual((await f.host.activityHistoryPage('session_a', owner)).records, []);
  await f.host.shutdown();
});

test('retention exposes a floor and explicit gap instead of claiming deleted history is complete', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nna-tombstone-retention-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = new NndActivityTombstones(join(root, 'catalog.json'));
  for (let index = 0; index <= TOMBSTONE_LIMIT; index++) {
    const context = { sessionId: `session_${index}`, createdAt: index + 1,
      subjectId: owner.subjectId, workspaceIds: new Set(owner.workspaceIds) };
    const sequence = await journal.prepare(context);
    await journal.committed(context, sequence);
  }
  const old = await journal.page(owner, new Map(), { after: 0, limit: 100 });
  assert.deepEqual({ status: old.status, floor: old.floor, records: old.records },
    { status: 'gap', floor: 1, records: [] });
  const page = await journal.page(owner, new Map(), { after: 1, limit: 100 });
  assert.equal(page.status, 'page'); assert.equal(page.records[0].sequence, 2);
  assert.equal(page.records.length, 100); assert.equal(page.historyComplete, false);
});

test('a same-ID same-time session owned by another principal cannot hide an older deletion intent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nna-tombstone-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = new NndActivityTombstones(join(root, 'catalog.json'));
  const old = { sessionId: 'session_a', createdAt: 100,
    subjectId: owner.subjectId, workspaceIds: new Set(owner.workspaceIds) };
  await journal.prepare(old);
  const other = { ...old, subjectId: 'another-operator' };
  const contexts = new Map([['session_a', other]]);
  assert.equal((await journal.page(owner, contexts)).records[0].sessionID, 'session_a');
});
