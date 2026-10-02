// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveManifest } from '../src/config.js';
import { TypedSessionEngine as SessionEngine } from './typed-provider-fixture.js';
import { runEngineSubagent, subagentConfig } from '../src/subagent-runtime.js';
import { recoverJournal } from '../src/store.js';
import { subagentDefinition } from '../src/subagent-tool.js';

test('child session journals and telemetry retain parent lineage after shutdown and resume', async (t) => {
  const testContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  t.after(() => { if (testContext === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = testContext; });
  const root = await mkdtemp(join(tmpdir(), 'nna-lineage-'));
  const config = resolveManifest({ persistence: 'durable', workspace_root: root,
    providers: [{ id: 'local', endpoint: 'http://127.0.0.1:1234/v1', model: 'fixture', trust_zone: 'loopback' }] });
  const providerFactory = () => ({ async *stream() {
    yield { type: 'text', text: 'Reviewed.' }; yield { type: 'terminal', finishReason: 'stop', usage: null };
  } });
  const options = { config, sessionId: 'parent', storeRoot: join(root, 'sessions'), telemetryRoot: join(root, 'telemetry'),
    providerFactory, reviewerRoot: join(root, 'reviews'), governanceRoot: join(root, 'governance'), skillRoots: [], hookRoots: [] };
  const parent = new SessionEngine(options);
  await parent.initialize(); parent.active = { turnId: 'parent-turn', stepId: 'parent-step' };
  let childId;
  try {
    const result = await runEngineSubagent(parent, { type: 'general', task: 'Reply briefly.' }, new AbortController().signal,
      (childOptions) => { childId = childOptions.sessionId; return new SessionEngine(childOptions); }, { toolRequestId: 'launch-tool' });
    assert.equal(result.outcome, 'completed');
    const parentJournal = await recoverJournal(parent.store.path);
    const associations = parentJournal.records.filter((r) => r.type === 'subagent_session');
    assert.deepEqual(associations.map((r) => r.payload.state), ['created', 'running', 'completed']);
    const childJournal = await recoverJournal(join(options.storeRoot, `${childId}.journal.ndjson`));
    const lineage = childJournal.records[0].payload.lineage;
    assert.equal(lineage.parent_session_id, parent.sessionId);
    assert.equal(lineage.parent_turn_id, 'parent-turn');
    assert.equal(lineage.launching_tool_request_id, 'launch-tool');
    assert.deepEqual(lineage, Object.fromEntries(Object.entries(associations[0].payload).filter(([k]) => !['state', 'updated_at'].includes(k))));
    const rows = await parent.telemetry.query({ sessionId: childId, limit: 1000 });
    assert.ok(rows.some((r) => r.event_name === 'provider.request'));
    assert.ok(rows.every((r) => r.agent_run_id === lineage.agent_run_id));
    const resumed = new SessionEngine({ ...options, sessionId: childId, config: subagentConfig(config, 'general') });
    await resumed.initialize();
    try { assert.deepEqual(resumed.sessionLineage, lineage); assert.equal(resumed.telemetry.conversationId, 'parent'); }
    finally { await resumed.shutdown({ request_id: 'resume-shutdown', type: 'shutdown' }); }
  } finally { parent.active = null; await parent.shutdown({ request_id: 'shutdown', type: 'shutdown' }); }
});

test('failed initialization remains associated and durable launch failure prevents child creation', async () => {
  const writes = [];
  const parent = { sessionId: 'parent', active: { turnId: 'turn', stepId: 'step' }, subagentDepth: 0,
    config: { executionManifest: null, routes: { subagent: { model: 'worker' } } }, output: async () => {},
    store: { append: async (type, payload) => writes.push({ type, payload }) } };
  let shutdown = false;
  await assert.rejects(runEngineSubagent(parent, { type: 'general', task: 'review' }, new AbortController().signal, () => ({
    initialize: async () => { throw new Error('initialization failed'); }, shutdown: async () => { shutdown = true; },
  })), /initialization failed/u);
  assert.equal(shutdown, true);
  assert.deepEqual(writes.map((r) => r.payload.state), ['created', 'failed']);
  parent.store.append = async () => { throw new Error('storage failed'); };
  let created = false;
  await assert.rejects(runEngineSubagent(parent, { type: 'general', task: 'review' }, new AbortController().signal,
    () => { created = true; }), /storage failed/u);
  assert.equal(created, false);
});

test('agent tool forwards the launching lifecycle request id independently of task input', async () => {
  let launch;
  const tool = subagentDefinition({ run: async (_input, _signal, value) => {
    launch = value; return { session_id: 'child', outcome: 'completed', text: 'done' };
  } });
  await tool.executor({ id: 'tool-launch', args: { type: 'general', task: 'review' } }, new AbortController().signal);
  assert.deepEqual(launch, { toolRequestId: 'tool-launch' });
});

test('cancellation during initialization records a canceled child without submitting work', async () => {
  const controller = new AbortController(); const states = []; let submitted = false; let closed = false;
  const parent = { sessionId: 'parent', active: { turnId: 'turn', stepId: 'step' }, subagentDepth: 0,
    config: { executionManifest: null, routes: { subagent: { model: 'worker' } } }, output: async () => {},
    store: { append: async (_type, record) => states.push(record.state) } };
  await assert.rejects(runEngineSubagent(parent, { type: 'general', task: 'review' }, controller.signal, () => ({
    initialize: async () => controller.abort(), cancel: async () => {},
    submit: async () => { submitted = true; }, shutdown: async () => { closed = true; },
  })), { code: 'tool_cancelled' });
  assert.equal(submitted, false); assert.equal(closed, true);
  assert.deepEqual(states, ['created', 'cancelled']);
});
