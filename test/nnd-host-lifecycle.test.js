// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NndEngineHost } from '../src/nnd-engine-host.js';

const owner = { subjectId: 'operator', workspaceIds: ['workspace'] };
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const message = { type: 'message', role: 'user', content: 'hello', turnId: 'turn_1' };
const records = [{ type: 'turn_accepted', payload: { turnId: 'turn_1' } },
  { type: 'message', payload: message }, { type: 'turn_outcome', payload: { turnId: 'turn_1' } }];
const forkBody = { messageID: 'parent:message:0' };

function engine(sessionId, shutdowns, options = {}) {
  return { config: { workspaceRoot: 'D:\\workspace' }, transcript: sessionId === 'parent' ? [message] : [],
    active: null, state: { state: 'idle' },
    ...(sessionId === 'parent' ? { store: { readRecords: options.readRecords ?? (async () => ({ records })),
      append: options.append ?? (async () => {}) } } : {}),
    async initialize() { await options.initialize?.(sessionId); },
    async shutdown() { shutdowns.push(sessionId); await options.shutdown?.(); } };
}

test('shutdown waits for a direct create admitted before teardown and blocks later create and turn admission', async () => {
  const entered = deferred(), release = deferred(), shutdowns = [];
  const host = new NndEngineHost({ createEngine: async ({ sessionId }) => engine(sessionId, shutdowns,
    { initialize: async () => { entered.resolve(); await release.promise; } }) });
  const creating = host.create('pending', owner);
  await entered.promise;
  const shuttingDown = host.shutdown();
  assert.equal(shuttingDown, host.shutdown(), 'concurrent shutdown callers share one teardown');
  await assert.rejects(host.create('late', owner), { code: 'nnd_session_unavailable' });
  release.resolve();
  await creating;
  assert.deepEqual(host.submitAsync('pending', { request_id: 'late', content: 'late' }, owner),
    { accepted: false, reason: 'busy' });
  await shuttingDown;
  assert.deepEqual(shutdowns, ['pending']);
});

test('shutdown stops a fork before child admission and waits for its journal read', async () => {
  const entered = deferred(), release = deferred(), shutdowns = [], created = [];
  const host = new NndEngineHost({ createEngine: async ({ sessionId }) => {
    created.push(sessionId);
    return engine(sessionId, shutdowns, { readRecords: async () => {
      entered.resolve(); await release.promise; return { records };
    } });
  } });
  await host.create('parent', owner);
  const forking = host.fork('parent', owner, forkBody);
  await entered.promise;
  await assert.rejects(host.revert('parent', owner, forkBody), { code: 'nnd_revert_busy' });
  await assert.rejects(host.close('parent', owner), { code: 'nnd_revert_busy' });
  assert.deepEqual(host.submitAsync('parent', { request_id: 'late', content: 'late' }, owner),
    { accepted: false, reason: 'busy' });
  const shuttingDown = host.shutdown();
  await assert.rejects(host.fork('parent', owner, forkBody), { code: 'nnd_fork_busy' });
  release.resolve();
  await assert.rejects(forking, { code: 'nnd_session_unavailable' });
  await shuttingDown;
  assert.deepEqual(created, ['parent']);
  assert.deepEqual(shutdowns, ['parent']);
});

test('shutdown re-snapshots contexts after an admitted fork finishes child creation', async () => {
  const entered = deferred(), release = deferred(), shutdowns = [];
  const host = new NndEngineHost({ createEngine: async ({ sessionId }) => engine(sessionId, shutdowns,
    { initialize: async (id) => { if (id !== 'parent') { entered.resolve(); await release.promise; } } }) });
  await host.create('parent', owner);
  const forking = host.fork('parent', owner, forkBody);
  await entered.promise;
  const shuttingDown = host.shutdown();
  release.resolve();
  await forking;
  await shuttingDown;
  assert.equal(shutdowns.length, 2);
  assert.ok(shutdowns.includes('parent'));
  assert.ok(shutdowns.some((id) => id !== 'parent'));
});

test('shutdown waits for an admitted close instead of shutting its engine down twice', async () => {
  const entered = deferred(), release = deferred(), shutdowns = [];
  const host = new NndEngineHost({ createEngine: async ({ sessionId }) => engine(sessionId, shutdowns) });
  await host.create('parent', owner);
  const prepare = host.tombstones.prepare.bind(host.tombstones);
  host.tombstones.prepare = async (...args) => { entered.resolve(); await release.promise; return prepare(...args); };
  const closing = host.close('parent', owner);
  await entered.promise;
  const shuttingDown = host.shutdown();
  await assert.rejects(host.create('late', owner), { code: 'nnd_session_unavailable' });
  release.resolve();
  await closing;
  await shuttingDown;
  assert.deepEqual(shutdowns, ['parent']);
});

test('fork cannot read a timeline while revert is replaying that timeline', async () => {
  const entered = deferred(), release = deferred(), shutdowns = [];
  const journal = [...records];
  let reads = 0;
  const host = new NndEngineHost({ createEngine: async ({ sessionId }) => engine(sessionId, shutdowns,
    { readRecords: async () => { reads++; entered.resolve(); await release.promise; return { records: journal }; } }) });
  await host.create('parent', owner);
  const reverting = host.revert('parent', owner, forkBody);
  await entered.promise;
  await assert.rejects(host.fork('parent', owner, forkBody), { code: 'nnd_fork_busy' });
  assert.equal(reads, 1, 'rejected fork must not read the journal');
  release.resolve();
  await reverting;
  await host.shutdown();
});

test('a failed catalog deletion does not shut an already stopped context down twice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-nnd-shutdown-'));
  const shutdowns = [];
  const host = new NndEngineHost({ catalogPath: join(root, 'catalog.json'),
    createEngine: async ({ sessionId }) => engine(sessionId, shutdowns) });
  await host.create('parent', owner);
  host.persistCatalog = async () => { throw new Error('catalog write failed'); };
  await assert.rejects(host.close('parent', owner), /catalog write failed/u);
  await host.shutdown();
  assert.deepEqual(shutdowns, ['parent']);
});

test('failed host shutdown can retry settled engines but never reopens admission', async () => {
  const shutdowns = [];
  let attempts = 0;
  const host = new NndEngineHost({ createEngine: async ({ sessionId }) => engine(sessionId, shutdowns,
    { shutdown: async () => { if (++attempts === 1) throw new Error('engine shutdown failed'); } }) });
  await host.create('parent', owner);
  await assert.rejects(host.shutdown(), /engine shutdown failed/u);
  await assert.rejects(host.create('late', owner), { code: 'nnd_session_unavailable' });
  await host.shutdown();
  assert.deepEqual(shutdowns, ['parent', 'parent']);
  await host.shutdown();
  assert.deepEqual(shutdowns, ['parent', 'parent']);
});
