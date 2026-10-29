// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationCreation } from '../src/desktop-conversation-start.js';
import { DesktopEngineHost } from '../src/desktop-engine-host.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startIntegrationServer } from '../src/integration-server.js';
import { createDesktopLocalIntegrationActivation } from '../src/nno-integration-activation.js';

test('conversation creation identity binds operation to operator and settings', () => {
  const principal = { subjectId: 'operator' }, operation = 'draft_0123456789abcdef';
  const input = { directory: 'D:/work', modelRoute: { providerId: 'local', model: 'model-a' } };
  const first = conversationCreation(principal, input, operation);
  assert.deepEqual(conversationCreation(principal, input, operation), first);
  const changed = conversationCreation(principal, { ...input, directory: 'D:/other' }, operation);
  assert.equal(changed.sessionId, first.sessionId);
  assert.notEqual(changed.options.creationFingerprint, first.options.creationFingerprint);
  assert.notEqual(conversationCreation(principal, { ...input, startFingerprint: 'f'.repeat(64) }, operation).options.creationFingerprint, first.options.creationFingerprint);
  assert.notEqual(conversationCreation({ subjectId: 'other' }, input, operation).sessionId, first.sessionId);
  assert.throws(() => conversationCreation(principal, input, 'bad'), { code: 'request_invalid' });
});

test('a retried creation restores the same session, selected model and review mode', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nna-conversation-start-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const principal = { subjectId: 'operator', workspaceIds: ['workspace'] };
  const input = conversationCreation(principal, { directory: root, reviewMode: 'unattended',
    modelRoute: { providerId: 'selected', model: 'selected-model' } }, 'draft_0123456789abcdef');
  let factories = 0;
  const make = () => new DesktopEngineHost({ catalogPath: join(root, 'catalog.json'), createEngine: async options => {
    factories += 1;
    return { config: { workspaceRoot: root, routes: { primary: options.modelRoute } },
      async initialize() {}, async shutdown() {} };
  } });
  const first = make();
  await first.create(input.sessionId, principal, input.options);
  await first.create(input.sessionId, principal, input.options);
  assert.equal(factories, 1);
  await assert.rejects(first.create(input.sessionId, principal, { ...input.options, creationFingerprint: 'a'.repeat(64) }), { code: 'desktop_session_exists' });
  await first.shutdown();
  const restored = make(); await restored.initialize();
  await restored.create(input.sessionId, principal, input.options);
  assert.equal(factories, 2);
  const session = restored.get(input.sessionId, principal);
  assert.deepEqual(session.metadata.desktop.configuredModel, { providerID: 'selected', modelID: 'selected-model' });
  assert.equal(restored.reviewMode(input.sessionId, principal).effective, 'unattended');
  await restored.close(input.sessionId, principal);
  await assert.rejects(restored.create(input.sessionId, principal, input.options), { code: 'desktop_session_unavailable' });
  await restored.shutdown();
});


test('an expired creation record cannot revive an earlier conversation journal', async () => {
  const principal = { subjectId: 'operator', workspaceIds: ['workspace'] };
  const input = conversationCreation(principal, { directory: '/workspace' }, 'draft_0123456789abcdef');
  const host = new DesktopEngineHost({ createEngine: async () => ({ config: { workspaceRoot: '/workspace' },
    transcript: [{ role: 'user', content: 'Earlier history' }], async initialize() {}, async shutdown() {} }) });
  await assert.rejects(host.create(input.sessionId, principal, input.options), { code: 'desktop_session_unavailable' });
  assert.deepEqual(host.list(principal), []);
});

test('native HTTP replays the same creation and refuses changed start content', async t => {
  const principal = { subjectId: 'operator', platformRole: 'operator', workspaceIds: ['workspace'], permissions: ['desktop.read', 'desktop.session.create'] };
  const host = new DesktopEngineHost({ createEngine: async options => ({ config: { workspaceRoot: '/workspace', routes: { primary: options.modelRoute } },
    async initialize() {}, async shutdown() {} }) });
  const token = 'conversation-start-test-token-0123456789';
  const server = await startIntegrationServer({ activation: createDesktopLocalIntegrationActivation(), token, port: 0,
    desktopEngineHost: host, desktopWorkspaceRoot: '/workspace', resolvePrincipal: () => principal });
  t.after(async () => { server.server.closeAllConnections(); await server.close(); await host.shutdown(); });
  const body = { operation_id: 'draft_0123456789abcdef', start_fingerprint: 'a'.repeat(64), title: 'Question',
    providerID: 'selected', model: 'chosen', reviewMode: 'unattended' };
  const call = value => fetch(`http://127.0.0.1:${server.address.port}/session`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const first = await call(body), second = await call(body);
  assert.equal(first.status, 201); assert.equal(second.status, 201);
  assert.equal((await first.json()).id, (await second.json()).id);
  assert.equal(host.list(principal).length, 1);
  assert.equal((await call({ ...body, start_fingerprint: 'b'.repeat(64) })).status, 409);
  assert.equal((await call({ ...body, start_fingerprint: 'invalid' })).status, 400);
});
