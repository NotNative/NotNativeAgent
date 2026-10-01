// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NndEngineHost } from '../src/nnd-engine-host.js';
import { pendingRequests } from '../src/nnd-pending-requests.js';
import { QuestionBroker } from '../src/question-broker.js';
import { InteractivePermissionBroker } from '../src/permission-broker.js';
import { dispatchNndHarnessRequest } from '../src/nnd-harness-routes.js';
import { sendFailure } from '../src/secret-broker-server.js';

const owner = { subjectId: 'owner', workspaceIds: ['workspace_a'], permissions: ['nnd.read'] };
const engine = () => ({ config: {}, active: null, transcript: [], permissionBroker: null, questionBroker: null,
  async initialize() {}, async shutdown() {} });

test('native pending observation failures are service-unavailable responses rather than invalid requests', async () => {
  const host = new NndEngineHost({ createEngine: async () => ({ ...engine(), questionBroker: undefined }) });
  await host.create('session_a', owner);
  const context = { url: new URL('http://nna/v1/nnd/pending'), principal: owner, nndWorkspaceRoot: '', nndEngineHost: host };
  const headers = {}; const response = { setHeader(name, value) { headers[name] = value; }, end(body) { this.body = body; } };
  try { await dispatchNndHarnessRequest({ method: 'GET' }, response, context); }
  catch (error) { sendFailure(response, error); }
  assert.equal(response.statusCode, 503);
  assert.deepEqual(JSON.parse(response.body).error, { code: 'nnd_pending_unavailable', message: 'NND pending request observation is unavailable' });
  assert.equal(headers['Cache-Control'], 'no-store'); await host.shutdown();
});

test('settled and expired permissions are not pending while prompt output is still blocked', async (t) => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const request = { id: 'tool_a', toolName: 'process', args: {}, resolved: {}, authorityId: 'authority_a',
    authorityVersion: 1, policyVersion: 1, definitionVersion: 1 };
  const context = { definition: { purpose: 'Test', scope: 'workspace', sideEffect: 'reversible', operatorConfirmation: 'one_shot' } };
  for (const settlement of ['approval', 'expiry']) {
    let release; const hold = new Promise((resolve) => { release = resolve; });
    const broker = new InteractivePermissionBroker({ output: async () => hold, timeoutMs: 1000 });
    const controller = new AbortController(); const waiting = broker.request(request, {}, context, controller.signal);
    const runtime = { ...engine(), permissionBroker: broker };
    const token = pendingRequests(runtime).permissions[0].id;
    if (settlement === 'approval') broker.decide({ permission_token: token, tool_request_id: request.id, choice: 'allow_once' }, owner);
    else now += 1001;
    assert.deepEqual(pendingRequests(runtime).permissions, []);
    controller.abort(); release(); await waiting;
  }
});

test('pending reads observe real questions and redact permission argument summaries', async () => {
  const broker = new QuestionBroker();
  const waiting = broker.ask({ id: 'tool_a', args: { questions: [{ question: 'Choose a port', options: [{ label: '3000', description: 'Local' }] }] } });
  const runtime = { ...engine(), questionBroker: broker, permissionBroker: { snapshot: () => [{ token: 'permission_a',
    requestId: 'tool_b', tool: 'process', expiresAt: 1000, summary: { secret: 'do not publish' } }] } };
  const projected = pendingRequests(runtime);
  assert.equal(projected.forms.length, 1);
  assert.equal(projected.forms[0].questions[0].question, 'Choose a port');
  assert.deepEqual(projected.permissions, [{ id: 'permission_a', toolRequestID: 'tool_b', permission: 'process', expiresAt: 1000 }]);
  assert.equal(JSON.stringify(projected).includes('do not publish'), false);
  broker.decline({ question_token: projected.forms[0].id }, owner);
  await waiting;
  assert.deepEqual(pendingRequests(runtime).forms, []);
  assert.throws(() => pendingRequests({ ...engine(), questionBroker: undefined }), { code: 'nnd_pending_unavailable' });
  assert.throws(() => pendingRequests({ ...engine(), questionBroker: { snapshot: () => Array(129).fill({}) } }), { code: 'nnd_pending_unavailable' });
});

test('pending snapshots include archived roots and children but preserve principal/workspace scope', async () => {
  const host = new NndEngineHost({ createEngine: async () => engine() });
  await host.create('session_a', owner);
  await host.setArchived('session_a', owner, 100);
  const complete = host.childSessions.register('child_a', 'session_a', owner, engine());
  host.childSessions.register('foreign_a', 'foreign_parent', { ...owner, subjectId: 'foreign' }, engine());
  const snapshot = host.pendingRequests(owner);
  assert.equal(snapshot.coverage, 'complete');
  assert.deepEqual(Object.keys(snapshot.sessions), ['session_a', 'child_a']);
  assert.deepEqual(snapshot.sessions.session_a.capabilities, { permissions: 'unsupported', forms: 'unsupported' });
  complete(); assert.deepEqual(host.pendingRequests(owner).sessions.child_a.forms, []);
  assert.deepEqual(Object.keys(host.pendingRequests({ ...owner, workspaceIds: ['other'] }).sessions), []);
  await host.shutdown();
});

test('restored noninteractive engines report authoritative unsupported request types', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nna-pending-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { catalogPath: join(root, 'catalog.json'), createEngine: async () => engine() };
  const host = new NndEngineHost(options); await host.create('session_a', owner); await host.shutdown();
  const restored = new NndEngineHost(options); await restored.initialize();
  assert.equal(restored.pendingRequests(owner).coverage, 'complete');
  assert.deepEqual(restored.pendingRequests(owner).sessions.session_a.forms, []);
  await restored.shutdown();
});

test('native pending read requires the integration read grant and refuses mutation', async () => {
  const host = new NndEngineHost({ createEngine: async () => engine() }); await host.create('session_a', owner);
  const context = { url: new URL('http://nna/v1/nnd/pending'), principal: owner, nndWorkspaceRoot: '', nndEngineHost: host };
  const response = { setHeader() {}, writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
  assert.equal(await dispatchNndHarnessRequest({ method: 'GET' }, response, context), true);
  assert.equal(response.statusCode, 200); assert.equal(JSON.parse(response.body).coverage, 'complete');
  await assert.rejects(dispatchNndHarnessRequest({ method: 'GET' }, response, { ...context, principal: { ...owner, permissions: [] } }), { code: 'integration_permission_denied' });
  await dispatchNndHarnessRequest({ method: 'PUT' }, response, context); assert.equal(response.statusCode, 405);
  await host.shutdown();
});
