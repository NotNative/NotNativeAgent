// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NndEngineHost } from '../src/nnd-engine-host.js';
import { activityPath, appendActivity, persistActivity } from '../src/nnd-activity-snapshot.js';

const owner = { subjectId: 'operator', workspaceIds: ['primary', 'second'] };
const engine = () => ({ config: { executionManifest: null }, async initialize() {}, async shutdown() {} });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nna-activity-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalogPath = join(root, 'catalog.json');
  const createHost = () => new NndEngineHost({ catalogPath, createEngine: async () => engine() });
  const host = createHost();
  const context = await host.create('session_a', owner);
  const createdAt = host.get(context.sessionId, owner).time.created;
  const save = (records) => persistActivity(catalogPath, 'session_a', createdAt, records);
  return { catalogPath, createHost, createdAt, host, save };
}

function rows(count) {
  const records = [];
  for (let index = 0; index < count; index += 1) {
    appendActivity(records, { id: `event_${index}`, sessionID: 'session_a', kind: 'notice',
      status: 'completed', summary: `Event ${index}` });
  }
  return records;
}

test('owner pages one exact durable Activity suffix across restart without projecting private fields', async t => {
  const f = await fixture(t);
  const records = rows(5);
  appendActivity(records, { id: 'tool_safe', sessionID: 'session_a', kind: 'tool', status: 'completed',
    summary: 'Tool completed', toolEvidence: { tool: 'shell_run', target: 'private-command-123',
      arguments: { token: 'private-token-123' }, effect: 'read_only' } });
  await f.save(records);
  const first = await f.host.activityHistoryPage('session_a', owner, { limit: 2 });
  assert.equal(first.status, 'page');
  assert.deepEqual(first.records.map((row) => row.id), ['event_4', 'tool_safe']);
  assert.equal(first.snapshot.durablePresent, true);
  assert.equal(first.snapshot.retainedCount, 6);
  assert.equal(first.snapshot.retainedLowerBound, 'event_0');
  assert.equal(first.snapshot.retainedUpperBound, 'tool_safe');
  assert.equal(first.snapshot.historyComplete, false);
  assert.equal(JSON.stringify(first).includes('private-command-123'), false);
  assert.equal(JSON.stringify(first).includes('private-token-123'), false);
  await f.host.shutdown();
  const reopened = f.createHost(); await reopened.initialize();
  const second = await reopened.activityHistoryPage('session_a', owner, { limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.records.map((row) => row.id), ['event_2', 'event_3']);
  assert.equal(second.snapshot.digest, first.snapshot.digest);
  const third = await reopened.activityHistoryPage('session_a', owner, { limit: 2, cursor: second.nextCursor });
  assert.deepEqual(third.records.map((row) => row.id), ['event_0', 'event_1']);
  assert.equal(third.nextCursor, null);
  await assert.rejects(reopened.activityHistoryPage('session_a', { subjectId: owner.subjectId,
    workspaceIds: ['primary'] }), { code: 'nnd_session_unavailable' });
  await assert.rejects(reopened.activityHistoryPage('session_a', { ...owner, subjectId: 'other' }),
    { code: 'nnd_session_unavailable' });
  await reopened.shutdown();
});

test('changed durable snapshot and session reincarnation return explicit gaps instead of mixing pages', async t => {
  const f = await fixture(t);
  const records = rows(4); await f.save(records);
  const first = await f.host.activityHistoryPage('session_a', owner, { limit: 2 });
  appendActivity(records, { id: 'event_4', sessionID: 'session_a', kind: 'notice',
    status: 'completed', summary: 'Event 4' });
  await f.save(records);
  const changed = await f.host.activityHistoryPage('session_a', owner, { limit: 2, cursor: first.nextCursor });
  assert.deepEqual({ status: changed.status, reason: changed.reason, records: changed.records },
    { status: 'gap', reason: 'snapshot_changed', records: [] });
  await f.host.close('session_a', owner);
  while (Date.now() <= f.createdAt) await new Promise((resolve) => setTimeout(resolve, 1));
  await f.host.create('session_a', owner);
  const recreated = await f.host.activityHistoryPage('session_a', owner, { limit: 2, cursor: first.nextCursor });
  assert.equal(recreated.status, 'gap');
  assert.equal(recreated.reason, 'session_recreated');
  assert.equal(recreated.snapshot.durablePresent, false);
  await f.host.shutdown();
});

test('a close that starts during disk paging revokes the page before it returns', async t => {
  const f = await fixture(t);
  await f.save(rows(10));
  const pending = f.host.activityHistoryPage('session_a', owner, { limit: 5 });
  const closing = f.host.close('session_a', owner);
  await assert.rejects(pending, { code: 'nnd_session_unavailable' });
  await closing;
  await f.host.shutdown();
});

test('retention and absent disk state never claim complete Activity history', async t => {
  const f = await fixture(t);
  const absent = await f.host.activityHistoryPage('session_a', owner);
  assert.equal(absent.status, 'page');
  assert.deepEqual(absent.records, []);
  assert.equal(absent.snapshot.durablePresent, false);
  assert.equal(absent.snapshot.historyComplete, false);
  const records = rows(501);
  assert.equal(records.length, 500);
  await f.save(records);
  const page = await f.host.activityHistoryPage('session_a', owner, { limit: 100 });
  assert.equal(page.snapshot.retainedCount, 500);
  assert.equal(page.snapshot.retentionLimit, 500);
  assert.equal(page.snapshot.retainedLowerBound, 'event_1');
  assert.equal(page.records[0].id, 'event_401');
  assert.ok(page.nextCursor);
  appendActivity(records, { id: 'event_501', sessionID: 'session_a', kind: 'notice',
    status: 'completed', summary: 'Event 501' });
  await f.save(records);
  const gap = await f.host.activityHistoryPage('session_a', owner, { limit: 100, cursor: page.nextCursor });
  assert.equal(gap.status, 'gap');
  assert.equal(gap.reason, 'snapshot_changed');
  await f.host.shutdown();
});

test('foreign or malformed cursor and corrupt disk snapshot fail closed', async t => {
  const f = await fixture(t);
  await f.save(rows(3));
  const page = await f.host.activityHistoryPage('session_a', owner, { limit: 1 });
  for (const cursor of ['?', 'abc', `${page.nextCursor}=`, 'a'.repeat(769)]) {
    await assert.rejects(f.host.activityHistoryPage('session_a', owner, { limit: 1, cursor }),
      { code: cursor.length > 768 ? 'nnd_activity_page_invalid' : 'nnd_activity_cursor_invalid' });
  }
  await f.host.create('session_b', owner);
  await assert.rejects(f.host.activityHistoryPage('session_b', owner, { limit: 1, cursor: page.nextCursor }),
    { code: 'nnd_activity_cursor_invalid' });
  await assert.rejects(f.host.activityHistoryPage('session_a', owner, { limit: 101 }),
    { code: 'nnd_activity_page_invalid' });
  await writeFile(activityPath(f.catalogPath, 'session_a'), '{bad json');
  await assert.rejects(f.host.activityHistoryPage('session_a', owner), { code: 'nnd_activity_invalid' });
  await f.host.shutdown();
});
