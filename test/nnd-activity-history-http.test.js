// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NndEngineHost } from '../src/nnd-engine-host.js';
import { appendActivity, persistActivity } from '../src/nnd-activity-snapshot.js';
import { startIntegrationServer } from '../src/integration-server.js';
import { createNndLocalIntegrationActivation } from '../src/nno-integration-activation.js';

const token = 'test-activity-http-token-with-at-least-32-characters';
const actor = (subject = 'operator', permissions = ['nnd.read'], workspaces = ['primary']) => ({
  subject_id: subject, platform_role: 'user', permissions, workspace_ids: workspaces,
  group_ids: [], trace_id: 'activity_test', request_id: 'activity_page', issued_at: new Date().toISOString(),
});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nna-activity-http-'));
  const catalogPath = join(root, 'catalog.json');
  const host = new NndEngineHost({ catalogPath, createEngine: async () => ({
    config: { executionManifest: null }, async initialize() {}, async shutdown() {},
  }) });
  const context = await host.create('session_a', { subjectId: 'operator', workspaceIds: ['primary'] });
  const createdAt = host.get('session_a', { subjectId: 'operator', workspaceIds: ['primary'] }).time.created;
  const service = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(),
    token, nndEngineHost: host, port: 0 });
  t.after(async () => { await service.close(); await host.shutdown(); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${service.address.port}`;
  const request = async (path, principal = actor(), options = {}) => {
    const response = await fetch(base + path, { method: options.method ?? 'GET', redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'x-nna-principal': Buffer.from(JSON.stringify(principal)).toString('base64url') } });
    return { status: response.status, body: await response.json() };
  };
  return { catalogPath, createdAt, context, host, base, request };
}

test('authenticated owner pages durable Activity and receives an explicit snapshot gap', async t => {
  const f = await fixture(t);
  const rows = [];
  for (let i = 0; i < 3; i++) appendActivity(rows, { id: `event_${i}`, sessionID: 'session_a',
    kind: 'notice', status: 'completed', summary: `Event ${i}` });
  await persistActivity(f.catalogPath, 'session_a', f.createdAt, rows);
  f.context.activity.push(...rows);
  const path = '/v1/nnd/sessions/session_a/activity-history';
  const first = await f.request(path + '?limit=1');
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.records.map(row => row.id), ['event_2']);
  assert.equal(first.body.snapshot.historyComplete, false);
  assert.equal(first.body.liveBoundary.status, 'paired');
  assert.match(first.body.liveBoundary.cursor, /^evt_/u);
  assert.ok(first.body.nextCursor);
  const second = await f.request(path + '?limit=1&cursor=' + encodeURIComponent(first.body.nextCursor));
  assert.deepEqual(second.body.records.map(row => row.id), ['event_1']);
  appendActivity(rows, { id: 'event_3', sessionID: 'session_a', kind: 'notice', status: 'completed', summary: 'new' });
  await persistActivity(f.catalogPath, 'session_a', f.createdAt, rows);
  const gap = await f.request(path + '?limit=1&cursor=' + encodeURIComponent(first.body.nextCursor));
  assert.deepEqual({ status: gap.status, result: gap.body.status, reason: gap.body.reason, records: gap.body.records },
    { status: 200, result: 'gap', reason: 'snapshot_changed', records: [] });
});

test('each page reauthenticates ownership, permission, method and bounded query', async t => {
  const f = await fixture(t); const path = '/v1/nnd/sessions/session_a/activity-history';
  assert.equal((await fetch(f.base + path)).status, 401);
  assert.equal((await f.request(path, actor('operator', []))).status, 403);
  assert.equal((await f.request(path, actor('other'))).status, 404);
  assert.equal((await f.request(path, actor('operator', ['nnd.read'], ['second']))).status, 404);
  assert.equal((await f.request(path + '?limit=1&limit=2')).status, 400);
  assert.equal((await f.request(path + '?unknown=1')).status, 400);
  assert.equal((await f.request(path, actor(), { method: 'POST' })).status, 405);
  await f.host.close('session_a', { subjectId: 'operator', workspaceIds: ['primary'] });
  assert.equal((await f.request(path)).status, 404);
});
