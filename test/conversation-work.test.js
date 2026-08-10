// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationWork } from '../src/conversation-work.js';
import { conversationWorkDefinitions } from '../src/conversation-work-tools.js';
import { buildContext } from '../src/context.js';
import { planOverlay, taskOverlay } from '../src/tui-overlays.js';
import { sessionStatusLine } from '../src/tui-status-line.js';

test('conversation work enforces one active task and evidence-based completion', async () => {
  const records = [];
  const work = new ConversationWork({ persist: async (type, payload) => records.push({ type, payload }) });
  await work.setGoal('Ship a reliable planning workflow');
  await work.addTask('Implement durable state');
  await work.addTask('Verify restart behavior');
  await work.updateTask('T1', 'in_progress');
  await assert.rejects(work.updateTask('T2', 'in_progress'), { code: 'task_active_conflict' });
  await assert.rejects(work.updateTask('T1', 'completed'), { code: 'work_text_invalid' });
  await work.updateTask('T1', 'completed', 'State-machine tests pass.');
  await work.updateTask('T2', 'completed', 'Journal replay test passes.');
  await work.completeGoal('All planned acceptance checks pass.');
  assert.equal(work.snapshot().goal.status, 'completed');
  assert.equal(records.at(-1).type, 'work_state');
  assert.equal(records.at(-1).payload.revision, 7);
});

test('conversation work restores the latest durable snapshot exactly', async () => {
  const records = [];
  const first = new ConversationWork({ persist: async (type, payload) => records.push({ type, payload }) });
  await first.setGoal('Survive resume and compaction');
  await first.addTask('Persist current progress');
  await first.updateTask('T1', 'blocked', 'Waiting for external evidence.');
  const resumed = new ConversationWork();
  resumed.restore([{ type: 'work_state', payload: { schema: 'nna.conversation_work.v1', revision: 0, nextTaskNumber: 1, goal: null, tasks: [] } }, ...records]);
  assert.deepEqual(resumed.snapshot(), first.snapshot());
});

test('agent work tools share the same durable state machine', async () => {
  const work = new ConversationWork();
  const definitions = new Map(conversationWorkDefinitions(work).map((item) => [item.name, item]));
  const goal = definitions.get('work.goal');
  const add = definitions.get('work.task_add');
  await goal.executor({ args: { action: 'set', objective: 'Track model work' } }, new AbortController().signal);
  const output = await add.executor({ args: { title: 'Collect evidence' } }, new AbortController().signal);
  assert.match(output.content, /Collect evidence/u);
  assert.equal(work.snapshot().tasks[0].id, 'T1');
  await assert.rejects(
    goal.validate({ action: 'invent', objective: 'invalid' }),
    { code: 'tool_schema_invalid' },
  );
});

test('clearing conversation work records a durable empty revision', async () => {
  const records = [];
  const work = new ConversationWork({ persist: async (type, payload) => records.push({ type, payload }) });
  await work.setGoal('Temporary work');
  await work.addTask('Temporary task');
  await work.clear();
  assert.equal(work.snapshot().goal, null);
  assert.deepEqual(work.snapshot().tasks, []);
  assert.equal(records.at(-1).payload.revision, 3);
});

test('durable work state is kernel-grounded independently of compacted transcript records', () => {
  const config = { workspaceRoot: 'D:/work', limits: { maxContextBytes: 1_000_000 }, executionManifest: null, applicationPolicy: null };
  const work = { schema: 'nna.conversation_work.v1', revision: 4, nextTaskNumber: 2,
    goal: { id: 'goal_1', objective: 'Finish the slice', status: 'active' },
    tasks: [{ id: 'T1', title: 'Run tests', status: 'in_progress' }] };
  const context = buildContext(config, [{ type: 'compaction', summary: 'Older history compacted.', retainedRecords: [] }], 'Continue.', { work });
  const state = context.find((item) => item.provenance === 'conversation_work');
  assert.equal(state.trust, 'kernel');
  assert.match(state.content, /Finish the slice/u);
});

test('plan and task overlays expose structured progress with a compact footer indicator', () => {
  const work = { revision: 2, goal: { objective: 'Build it', status: 'active' }, tasks: [
    { id: 'T1', title: 'First', status: 'completed', evidence: 'done', blockedReason: null },
    { id: 'T2', title: 'Second', status: 'pending', evidence: null, blockedReason: null },
  ] };
  const plan = planOverlay(work);
  assert.equal(plan.kind, 'plan');
  assert.ok(plan.items.some((item) => item.id === 'task:T2'));
  assert.equal(taskOverlay(work, 'T2').parent, 'plan');
  const status = sessionStatusLine({
    metadata: { endpoint: 'local', model: 'model' }, usage: null, viewportEnd: null, viewportLineCount: 0,
    pendingAttachments: [], state: 'idle', reviewPosture: 'auto-review', contextLimitTokens: null,
    contextLimitBytes: null, work,
  }, 240);
  assert.match(status, /plan 1\/2/u);
});

test('footer keeps the active workspace visible and collapses a long provider route before the model', () => {
  const session = {
    metadata: { endpoint: 'http://provider-host.example:1234/v1', model: 'qwen-model', workspace: 'D:\\ProjectRepo\\NotNativeAgent' },
    usage: null, viewportEnd: null, viewportLineCount: 0, pendingAttachments: [], state: 'idle',
    reviewPosture: 'auto-review', contextLimitTokens: null, contextLimitBytes: null, work: null,
  };
  const wide = sessionStatusLine(session, 240);
  assert.match(wide, /IDLE \| D:\\ProjectRepo\\NotNativeAgent \| http:\/\/provider-host\.example:1234\/v1\/qwen-model/u);
  const narrow = sessionStatusLine(session, 100);
  assert.match(narrow, /IDLE \| D:\\ProjectRepo\\NotNativeAgent \| qwen-model/u);
  assert.doesNotMatch(narrow, /provider-host/u);
});

test('footer quietly right-aligns an update notice only when room is available', () => {
  const session = {
    metadata: { endpoint: 'local', model: 'model', workspace: 'D:\\work' }, usage: null,
    viewportEnd: null, viewportLineCount: 0, pendingAttachments: [], state: 'idle',
    reviewPosture: 'auto-review', contextLimitTokens: null, contextLimitBytes: null, work: null,
  };
  const wide = sessionStatusLine(session, 140, 'update available');
  assert.equal(wide.endsWith('update available'), true);
  assert.equal(wide.length, 140);
  const narrow = sessionStatusLine(session, 30, 'update available');
  assert.doesNotMatch(narrow, /update available/u);
});
