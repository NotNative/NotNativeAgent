// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationWork } from '../src/conversation-work.js';
import { conversationWorkDefinitions } from '../src/conversation-work-tools.js';
import { buildContext } from '../src/context.js';
import { planOverlay, taskOverlay } from '../src/tui-overlays.js';
import { sessionStatusLine } from '../src/tui-status-line.js';
import { workSummaryRows } from '../src/tui-work-summary.js';
import { TuiProjection } from '../src/tui-model.js';
import { TuiRenderer } from '../src/tui-renderer.js';

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

test('failed work persistence leaves authoritative in-memory state unchanged', async () => {
  const work = new ConversationWork({ persist: async () => { throw new Error('disk unavailable'); } });
  await assert.rejects(work.addTask('Must remain uncommitted'), /disk unavailable/u);
  assert.deepEqual(work.snapshot(), {
    schema: 'nna.conversation_work.v1', revision: 0, nextTaskNumber: 1, goal: null, tasks: [],
  });
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

test('responsive work shelf keeps goal and ordered tasks visible beside the composer', () => {
  const work = { revision: 5, goal: { objective: 'Ship visible conversation work', status: 'active' }, tasks: [
    { id: 'T1', title: 'Persist the goal', status: 'completed' },
    { id: 'T2', title: 'Render the task list', status: 'in_progress' },
    { id: 'T3', title: 'Verify compact mode', status: 'pending' },
  ] };
  const rows = workSummaryRows(work, 100, 30);
  assert.deepEqual(rows.map((row) => row.kind), [
    'work:goal:active', 'work:task:completed', 'work:task:in_progress', 'work:task:pending', 'work:hint',
  ]);
  assert.match(rows.map((row) => row.text).join('\n'), /GOAL ACTIVE · Ship visible conversation work · 1\/3 tasks complete/u);
  assert.match(rows.map((row) => row.text).join('\n'), /\[>\] T2  Render the task list/u);
  assert.equal(rows.at(-1).text.trim(), '/plan manage');

  const projection = new TuiProjection();
  projection.addSession('s1', 'Main', { provider: 'local', model: 'model' });
  projection.active().work = work;
  const frame = new TuiRenderer().frame(projection, { width: 100, height: 30, color: false });
  assert.match(frame, /GOAL ACTIVE · Ship visible conversation work/u);
  assert.match(frame, /\[x\] T1  Persist the goal/u);
  assert.match(frame, /\[>\] T2  Render the task list/u);
  assert.match(frame, /\/plan manage\n> \|/u);
});

test('compact work shelf exposes goal-only state and preserves the plan affordance', () => {
  const goalOnly = workSummaryRows({ goal: { objective: 'A very long durable goal that cannot fit in one narrow terminal row', status: 'active' }, tasks: [] }, 44, 20);
  assert.equal(goalOnly.length, 1);
  assert.match(goalOnly[0].text, /^Goal active/u);
  assert.match(goalOnly[0].text, /… · \/plan$/u);
  assert.equal(goalOnly[0].text.endsWith(' · /plan'), true);
  assert.equal(workSummaryRows({ goal: { objective: 'Hidden only when no safe room exists', status: 'active' }, tasks: [] }, 80, 8).length, 0);
});

test('footer uses deliberate wide and medium compositions', () => {
  const session = {
    metadata: { endpoint: 'http://provider-host.example:1234/v1', model: 'qwen-model', workspace: 'D:\\ProjectRepo\\NotNativeAgent' },
    usage: null, viewportEnd: null, viewportLineCount: 0, pendingAttachments: [], state: 'idle',
    reviewPosture: 'auto-review', contextLimitTokens: null, contextLimitBytes: null, work: null,
  };
  const wide = sessionStatusLine(session, 240);
  assert.match(wide, /IDLE \| D:\\ProjectRepo\\NotNativeAgent \| http:\/\/provider-host\.example:1234\/v1\/qwen-model/u);
  const narrow = sessionStatusLine(session, 100);
  assert.match(narrow, /IDLE \| NotNativeAgent \| qwen-model/u);
  assert.doesNotMatch(narrow, /provider-host/u);
  assert.doesNotMatch(narrow, /D:\\ProjectRepo/u);
});

test('footer compact composition prioritizes state, model, context, and viewport', () => {
  const session = {
    metadata: { endpoint: 'http://provider.example/v1', model: 'small-model', workspace: 'D:\\long\\workspace' },
    usage: { total_tokens: 99 }, viewportEnd: 4, viewportLineCount: 10, pendingAttachments: [], state: 'idle',
    reviewPosture: 'auto-review', contextTokens: 25, contextLimitTokens: 100, contextLimitBytes: null, work: null,
  };
  const compact = sessionStatusLine(session, 60);
  assert.match(compact, /^IDLE \| small-model \| context 25% \| 6 unseen$/u);
  assert.doesNotMatch(compact, /auto-review|workspace|provider|tokens/u);
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

test('footer shows elapsed time for the active turn and clears it when idle', () => {
  const session = {
    metadata: { endpoint: 'local', model: 'model', workspace: 'D:\\work' }, usage: null,
    viewportEnd: null, viewportLineCount: 0, pendingAttachments: [], state: 'running_tool',
    activeTurnId: 'turn_1', turnStartedAt: 1_000, reviewPosture: 'auto-review',
    contextLimitTokens: null, contextLimitBytes: null, work: null,
  };
  assert.match(sessionStatusLine(session, 180, '', 126_000), /RUNNING_TOOL 2m 05s/u);
  session.state = 'idle';
  session.activeTurnId = null;
  assert.doesNotMatch(sessionStatusLine(session, 180, '', 126_000), /2m 05s/u);
});
