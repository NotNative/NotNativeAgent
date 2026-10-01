// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NndEngineHost } from '../src/nnd-engine-host.js';
import { dispatchNndOperatorRequest } from '../src/nnd-operator-routes.js';
import { Readable } from 'node:stream';

const owner = { subjectId: 'owner', workspaceIds: ['workspace_a', 'workspace_b'],
  permissions: ['nnd.read', 'nnd.session.update'] };
function engine() {
  return { config: {}, reviewPosture: 'auto-review', transcript: [], active: null,
    async initialize() {}, async shutdown() {}, async submit() { return { accepted: true }; } };
}
const change = (mode, expected_revision = 0) => ({ mode, expected_revision });

test('review mode writes are scoped, validated, and publish a newer governance snapshot', async () => {
  const events = []; const runtime = engine();
  const host = new NndEngineHost({ createEngine: async () => runtime,
    eventBus: { publishSession: (event) => events.push(event) } });
  await host.create('session_a', owner);
  assert.deepEqual(host.reviewMode('session_a', owner), {
    mode: 'default', effective: 'auto-review', revision: 0,
    availableModes: ['default', 'auto-review', 'unattended'], defaultMode: 'auto-review' });
  const previous = host.get('session_a', owner).time.updated;
  assert.throws(() => host.setReviewMode('session_a', { ...owner, workspaceIds: ['workspace_a'] }, change('unattended')),
    { code: 'nnd_session_unavailable' });
  for (const body of [null, [], change('prompt'), change('full-control'), change('unattended', -1),
    change('unattended', 0.5), { ...change('unattended'), permission: '*' }]) {
    await assert.rejects(host.setReviewMode('session_a', owner, body), { code: 'review_posture_invalid' });
  }
  await host.setReviewMode('session_a', owner, change('unattended'));
  assert.equal(runtime.reviewPosture, 'unattended');
  const event = events.at(-1);
  assert.equal(event.type, 'session.updated');
  assert.ok(event.properties.info.time.updated > previous);
  assert.equal(event.properties.info.metadata.nnd.governance.reviewPosture, 'unattended');
  await host.setReviewMode('session_a', owner, change('default', 1));
  assert.equal(runtime.reviewPosture, 'auto-review');
});

test('durable review-mode CAS blocks ingress, rejects stale writes, and restores on restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nna-review-mode-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalogPath = join(root, 'catalog.json');
  let hold = false; let release; let writing;
  const runtime = engine();
  const host = new NndEngineHost({ catalogPath, createEngine: async () => runtime,
    persistCatalog: async (path, records) => {
      if (hold) { writing(); await new Promise((resolve) => { release = resolve; }); }
      await writeFile(path, JSON.stringify(records));
    } });
  await host.create('session_a', owner);
  hold = true;
  const entered = new Promise((resolve) => { writing = resolve; });
  const pending = host.setReviewMode('session_a', owner, change('unattended'));
  await entered;
  assert.equal(host.reviewMode('session_a', owner).effective, 'auto-review');
  assert.deepEqual(host.submitAsync('session_a', { version: '1.0', type: 'submit',
    request_id: 'prompt_a', content: 'Work' }, owner), { accepted: false, reason: 'busy' });
  await assert.rejects(host.submit('session_a', { version: '1.0', type: 'submit',
    request_id: 'prompt_b', content: 'Work' }, owner), { code: 'nnd_session_unavailable' });
  const stale = host.setReviewMode('session_a', owner, change('auto-review'));
  const rejected = assert.rejects(stale, { code: 'nnd_session_unavailable' });
  hold = false; release(); await pending; await rejected;
  assert.equal(host.reviewMode('session_a', owner).revision, 1);
  await host.shutdown();
  const restored = new NndEngineHost({ catalogPath, createEngine: async () => engine() });
  await restored.initialize();
  assert.equal(restored.reviewMode('session_a', owner).mode, 'unattended');
  assert.equal(restored.reviewMode('session_a', owner).effective, 'unattended');
  assert.equal(restored.reviewMode('session_a', owner).revision, 1);
  await restored.shutdown();
});

test('failed review-mode persistence preserves prior posture, catalog, revision, and ingress', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nna-review-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalogPath = join(root, 'catalog.json'); let fail = false;
  const runtime = engine();
  const host = new NndEngineHost({ catalogPath, createEngine: async () => runtime,
    persistCatalog: async (path, records) => {
      if (fail) throw new Error('disk failure');
      await writeFile(path, JSON.stringify(records));
    } });
  await host.create('session_a', owner);
  const prior = await readFile(catalogPath, 'utf8');
  fail = true;
  await assert.rejects(host.setReviewMode('session_a', owner, change('unattended')), /disk failure/u);
  assert.equal(runtime.reviewPosture, 'auto-review');
  assert.equal(host.reviewMode('session_a', owner).revision, 0);
  assert.equal(await readFile(catalogPath, 'utf8'), prior);
  assert.deepEqual(await host.submit('session_a', { version: '1.0', type: 'submit',
    request_id: 'prompt_a', content: 'Work' }, owner), { accepted: true });
  fail = false;
  await host.setReviewMode('session_a', owner, change('unattended'));
  runtime.active = { finalized: false };
  await assert.rejects(host.setReviewMode('session_a', owner, change('auto-review', 1)),
    { code: 'nnd_session_unavailable' });
  assert.equal(runtime.reviewPosture, 'unattended');
  await host.shutdown();
});

test('review-mode routes require read or update grants and preserve host ownership checks', async () => {
  const host = new NndEngineHost({ createEngine: async () => engine() });
  await host.create('session_a', owner);
  const route = async (method, principal, body) => {
    const request = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []); request.method = method;
    const response = { setHeader() {}, end(value) { this.value = JSON.parse(value); } };
    await dispatchNndOperatorRequest(request, response, {
      url: new URL('http://localhost/v1/nnd/sessions/session_a/review-mode'), principal, nndEngineHost: host });
    return response;
  };
  assert.equal((await route('GET', owner)).statusCode, 200);
  await assert.rejects(route('GET', { ...owner, permissions: [] }), { code: 'integration_permission_denied' });
  await assert.rejects(route('PUT', { ...owner, permissions: ['nnd.read'] }, change('unattended')),
    { code: 'integration_permission_denied' });
  await assert.rejects(route('PUT', { ...owner, subjectId: 'other' }, change('unattended')),
    { code: 'nnd_session_unavailable' });
  assert.equal((await route('POST', owner, change('unattended'))).statusCode, 405);
  const updated = await route('PUT', owner, change('unattended'));
  assert.equal(updated.statusCode, 200); assert.equal(updated.value.effective, 'unattended');
});

test('review mode cannot change during acknowledged ingress before engine active is exposed', async () => {
  let finish; const runtime = { ...engine(), submit: async () => new Promise((resolve) => { finish = resolve; }) };
  const host = new NndEngineHost({ createEngine: async () => runtime });
  await host.create('session_a', owner);
  assert.equal(host.submitAsync('session_a', { version: '1.0', type: 'submit',
    request_id: 'prompt_a', content: 'Work' }, owner).accepted, true);
  assert.equal(runtime.active, null);
  await assert.rejects(host.setReviewMode('session_a', owner, change('unattended')),
    { code: 'nnd_session_unavailable' });
  finish({ accepted: true });
  await new Promise((resolve) => setImmediate(resolve));
  await host.setReviewMode('session_a', owner, change('unattended'));
  assert.equal(runtime.reviewPosture, 'unattended');
  await host.shutdown();
});

