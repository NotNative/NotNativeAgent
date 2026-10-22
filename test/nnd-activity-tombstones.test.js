// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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

test('a bound session deletion uses the caller grant while retaining its exact session scope', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nna-tombstone-bound-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalogPath = join(root, 'catalog.json');
  const binding = { root, configured_root: root, id: 'primary', device: '1', inode: '1' };
  const principal = { subjectId: 'operator', workspaceIds: ['primary', 'second'] };
  const createEngine = async () => ({ config: { workspaceRoot: root, executionManifest: null },
    async initialize() {}, async shutdown() {} });
  const host = new NndEngineHost({ catalogPath, createEngine,
    primaryWorkspaceBinding: async () => binding });
  await host.create('session_a', principal);
  const createdAt = host.get('session_a', principal).time.created;
  await host.close('session_a', principal);
  const page = await host.activityTombstonesPage(principal);
  assert.deepEqual(page.records.map(({ sessionID, createdAt: at }) => [sessionID, at]), [['session_a', createdAt]]);
  assert.deepEqual((await host.activityTombstonesPage({ ...principal, workspaceIds: ['primary'] })).records, []);
  const journal = new NndActivityTombstones(catalogPath);
  await assert.rejects(journal.beforeCreate('session_a', principal, new Map(), true),
    { code: 'nnd_session_unavailable' });
  await host.shutdown();
  const reopened = new NndEngineHost({ catalogPath, createEngine,
    primaryWorkspaceBinding: async () => binding });
  await reopened.initialize();
  assert.deepEqual((await reopened.activityTombstonesPage(principal)).records, page.records);
  await reopened.shutdown();
});

test('an intent in a broader caller journal does not report a still-live bound session as deleted', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nna-tombstone-intent-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = new NndActivityTombstones(join(root, 'catalog.json'));
  const principal = { subjectId: 'operator', workspaceIds: ['primary', 'second'] };
  const context = { sessionId: 'session_a', createdAt: 100, subjectId: 'operator',
    workspaceIds: new Set(['primary']) };
  const live = new Map([['session_a', context]]);
  const sequence = await journal.prepare(context, live, principal);
  assert.deepEqual((await journal.page(principal, live)).records, []);
  assert.deepEqual((await journal.page(principal, new Map())).records.map((entry) => entry.sequence), [sequence]);
  await journal.committed(context, sequence, principal);
  assert.deepEqual((await journal.page(principal, live)).records.map((entry) => entry.sequence), [sequence]);
});

test('legacy exact-grant receipts without entry scope remain readable and finalizable', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nna-tombstone-legacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalogPath = join(root, 'catalog.json');
  const journal = new NndActivityTombstones(catalogPath);
  const context = { sessionId: 'session_a', createdAt: 100, subjectId: owner.subjectId,
    workspaceIds: new Set(owner.workspaceIds) };
  const sequence = await journal.prepare(context);
  const directory = `${catalogPath}.tombstones`;
  const [name] = await readdir(directory);
  const path = join(directory, name);
  const source = JSON.parse(await readFile(path, 'utf8'));
  delete source.entries[0].workspaceIds;
  await writeFile(path, JSON.stringify(source));
  await journal.committed(context, sequence);
  assert.equal((await journal.page(owner, new Map())).records[0].sessionID, 'session_a');
});

test('a broader caller cannot replay a deleted bound conversation from a legacy single-workspace journal', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nna-tombstone-legacy-grant-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalogPath = join(root, 'catalog.json');
  const journal = new NndActivityTombstones(catalogPath);
  const context = { sessionId: 'session_a', createdAt: 100, subjectId: owner.subjectId,
    workspaceIds: new Set(owner.workspaceIds) };
  const sequence = await journal.prepare(context);
  const [name] = await readdir(`${catalogPath}.tombstones`);
  const path = join(`${catalogPath}.tombstones`, name);
  const source = JSON.parse(await readFile(path, 'utf8'));
  delete source.entries[0].workspaceIds;
  await writeFile(path, JSON.stringify(source));
  await journal.committed(context, sequence);
  const binding = { root, configured_root: root, id: 'primary', device: '1', inode: '1' };
  const principal = { ...owner, workspaceIds: ['primary', 'second'] };
  const host = new NndEngineHost({ catalogPath, createEngine: async () => ({
    config: { workspaceRoot: root, executionManifest: null }, async initialize() {}, async shutdown() {},
  }), primaryWorkspaceBinding: async () => binding });
  await assert.rejects(host.create('session_a', principal, { creationFingerprint: 'a'.repeat(64) }),
    { code: 'nnd_session_unavailable' });
  assert.deepEqual((await host.activityTombstonesPage(principal)).records, []);
  await host.shutdown();
});

test('an entry scope outside its owner grant invalidates the journal', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nna-tombstone-scope-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalogPath = join(root, 'catalog.json');
  const journal = new NndActivityTombstones(catalogPath);
  const context = { sessionId: 'session_a', createdAt: 100, subjectId: owner.subjectId,
    workspaceIds: new Set(owner.workspaceIds) };
  await journal.prepare(context);
  const [name] = await readdir(`${catalogPath}.tombstones`);
  const path = join(`${catalogPath}.tombstones`, name);
  const source = JSON.parse(await readFile(path, 'utf8'));
  source.entries[0].workspaceIds = ['another-workspace'];
  await writeFile(path, JSON.stringify(source));
  await assert.rejects(journal.page(owner, new Map()), { code: 'nnd_activity_tombstones_invalid' });
});

test('a broader same-ID creation finalizes a narrow-grant intent before a repeated creation time', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nna-tombstone-cross-grant-intent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalogPath = join(root, 'catalog.json');
  const journal = new NndActivityTombstones(catalogPath);
  const old = { sessionId: 'session_a', createdAt: 100, subjectId: owner.subjectId,
    workspaceIds: new Set(owner.workspaceIds) };
  await journal.prepare(old);
  const binding = { root, configured_root: root, id: 'primary', device: '1', inode: '1' };
  const principal = { ...owner, workspaceIds: ['primary', 'second'] };
  const host = new NndEngineHost({ catalogPath, createEngine: async () => ({
    config: { workspaceRoot: root, executionManifest: null }, async initialize() {}, async shutdown() {},
  }), primaryWorkspaceBinding: async () => binding });
  const originalNow = Date.now;
  try {
    Date.now = () => old.createdAt;
    await host.create('session_a', principal);
  } finally { Date.now = originalNow; }
  const oldPage = await host.activityTombstonesPage(owner);
  assert.deepEqual(oldPage.records.map((entry) => entry.sessionID), ['session_a']);
  assert.equal(oldPage.records[0].createdAt, old.createdAt);
  await host.shutdown();
});

test('a live intent preceding a later deletion gives a gap instead of skipping a future receipt', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nna-tombstone-cursor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = new NndActivityTombstones(join(root, 'catalog.json'));
  const liveContext = { sessionId: 'session_a', createdAt: 100, subjectId: owner.subjectId,
    workspaceIds: new Set(owner.workspaceIds) };
  const deletedContext = { ...liveContext, sessionId: 'session_b', createdAt: 101 };
  const live = new Map([['session_a', liveContext]]);
  const first = await journal.prepare(liveContext, live);
  const second = await journal.prepare(deletedContext, live);
  await journal.committed(deletedContext, second);
  assert.deepEqual((await journal.page(owner, live)).status, 'gap');
  assert.equal((await journal.page(owner, live)).nextCursor, null);
  live.delete('session_a');
  const page = await journal.page(owner, live);
  assert.deepEqual(page.records.map((entry) => entry.sequence), [first, second]);
});

test('a page can advance through contiguous deletions before an unresolved intent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nna-tombstone-prefix-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = new NndActivityTombstones(join(root, 'catalog.json'));
  const context = (sessionId, createdAt) => ({ sessionId, createdAt, subjectId: owner.subjectId,
    workspaceIds: new Set(owner.workspaceIds) });
  const first = context('session_a', 100);
  const pending = context('session_b', 101);
  const later = context('session_c', 102);
  const firstSequence = await journal.prepare(first);
  await journal.committed(first, firstSequence);
  await journal.prepare(pending);
  const lastSequence = await journal.prepare(later);
  await journal.committed(later, lastSequence);
  const live = new Map([['session_b', pending]]);
  const page = await journal.page(owner, live);
  assert.equal(page.status, 'page');
  assert.deepEqual(page.records.map((entry) => entry.sequence), [firstSequence]);
  assert.equal(page.nextCursor, firstSequence);
  const gap = await journal.page(owner, live, { after: firstSequence });
  assert.equal(gap.status, 'gap');
  assert.equal(gap.nextCursor, null);
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
