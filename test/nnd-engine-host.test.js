import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { NndEngineHost } from '../src/nnd-engine-host.js';
import { activityPath, appendActivity } from '../src/nnd-activity-snapshot.js';
import { childSnapshotPath } from '../src/nnd-child-snapshot.js';
import { emitEngineStatus } from '../src/engine/output.js';
import { toolStatus } from '../src/engine/records.js';

const owner = { subjectId: 'user_a', workspaceIds: ['workspace_a'] };

test('NND session description exposes only classified governance state', async () => {
  const engine = fakeEngine();
  engine.config.routes = { primary: { providerId: 'local', model: 'root-model', endpoint: 'private endpoint', credential: 'private credential' } };
  engine.reviewPosture = 'prompt';
  let health = { status: 'attention', durable: true, attention_evidence: 2,
    unsettled_decisions: 1, uncertain_effects: 0, secret: 'never publish' };
  engine.governance = { health: () => health };
  const host = new NndEngineHost({ createEngine: async () => engine });
  await host.create('session_a', owner);
  assert.deepEqual(host.get('session_a', owner).metadata.nnd.governance, {
    reviewPosture: 'prompt', recordHealth: 'attention', durable: true,
    attentionEvidence: 2, unsettledDecisions: 1, uncertainEffects: 0,
  });
  assert.equal(JSON.stringify(host.list(owner)).includes('never publish'), false);
  assert.deepEqual(host.get('session_a', owner).metadata.nnd.configuredModel,
    { providerID: 'local', modelID: 'root-model' });
  assert.equal(JSON.stringify(host.list(owner)).includes('private endpoint'), false);
  assert.equal(JSON.stringify(host.list(owner)).includes('private credential'), false);
  health = { ...health, status: 'ready', attention_evidence: 0, unsettled_decisions: 0 };
  assert.equal(host.get('session_a', owner).metadata.nnd.governance.recordHealth, 'ready');
  engine.governance.health = () => { throw new Error('private governance failure'); };
  assert.deepEqual(host.get('session_a', owner).metadata.nnd.governance,
    { reviewPosture: 'prompt', recordHealth: 'unavailable' });
  await host.shutdown();
});

test('NND projects canonical work status live without publishing private work evidence', async () => {
  const events = [];
  let output;
  let work = { schema: 'nna.conversation_work.v1', revision: 0, goal: null, tasks: [] };
  const engine = { ...fakeEngine(), workStatus: () => work,
    submit: async () => new Promise(() => {}) };
  const host = new NndEngineHost({ eventBus: { publishSession: (event) => events.push(event) },
    createEngine: async (options) => { output = options.output; return engine; } });
  await host.create('session_a', owner);
  assert.deepEqual(host.get('session_a', owner).metadata.nnd.work,
    { revision: 0, goal: null, tasks: [] });
  assert.equal(host.submitAsync('session_a', { version: '1.0', type: 'submit',
    request_id: 'prompt_a', content: 'Build it' }, owner).accepted, true);
  work = { schema: 'nna.conversation_work.v1', revision: 1,
    goal: { id: 'goal_a', objective: 'Build it', status: 'active', evidence: 'private evidence' },
    tasks: [{ id: 'T1', title: 'Implement', status: 'in_progress', evidence: 'private task evidence' }] };
  output({ type: 'work_status', session_id: 'session_a', work: { secret: 'raw output must not publish' } });
  const projected = events.filter((event) => event.type === 'session.updated').at(-1).properties.info;
  assert.deepEqual(projected.metadata.nnd.work, { revision: 1,
    goal: { id: 'goal_a', objective: 'Build it', status: 'active' },
    tasks: [{ id: 'T1', title: 'Implement', status: 'in_progress' }] });
  assert.equal(JSON.stringify(events).includes('private evidence'), false);
  assert.equal(JSON.stringify(events).includes('raw output must not publish'), false);
  assert.throws(() => host.get('session_a', { subjectId: 'other', workspaceIds: owner.workspaceIds }),
    { code: 'nnd_session_unavailable' });
  const previous = events.length;
  output({ type: 'work_status', session_id: 'other', work });
  assert.equal(events.length, previous);
  work = { ...work, tasks: [{ id: 'invalid', title: 'Do not publish', status: 'pending' }] };
  output({ type: 'work_status', session_id: 'session_a', work });
  assert.equal(host.get('session_a', owner).metadata?.nnd?.work, undefined);
  await host.shutdown();
});

test('NND projects bounded semantic turn phases and settles them to idle', async () => {
  const events = [];
  let output;
  let resolveTurn;
  const engine = { ...fakeEngine(), transcript: [], submit: async () => new Promise((resolve) => { resolveTurn = resolve; }) };
  const host = new NndEngineHost({ eventBus: { publishSession: (event) => events.push(event) },
    createEngine: async (options) => { output = options.output; return engine; } });
  await host.create('session_a', owner);
  assert.equal(host.get('session_a', owner).metadata?.nnd?.turnState, undefined);
  assert.equal(host.submitAsync('session_a', { version: '1.0', type: 'submit',
    request_id: 'prompt_a', content: 'Do work' }, owner).accepted, true);
  output({ type: 'state_status', session_id: 'session_a', turn_id: 'turn_a', semantic_state: 'waiting_provider' });
  assert.deepEqual(host.get('session_a', owner).metadata.nnd.turnState, { phase: 'waiting_provider' });
  assert.deepEqual(host.activity('session_a', owner).filter((record) => record.kind === 'state').map((record) => record.summary), ['Waiting for model']);
  const prior = events.length;
  output({ type: 'state_status', session_id: 'session_a', turn_id: 'turn_a', semantic_state: 'waiting_provider' });
  output({ type: 'state_status', session_id: 'session_a', turn_id: 'turn_a', semantic_state: 'invented_state' });
  output({ type: 'state_status', session_id: 'other', turn_id: 'turn_a', semantic_state: 'running_tool' });
  output({ type: 'state_status', session_id: 'session_a', turn_id: 'other_turn', semantic_state: 'running_tool' });
  assert.equal(events.length, prior);
  output({ type: 'state_status', session_id: 'session_a', turn_id: 'turn_a', semantic_state: 'running_tool' });
  assert.deepEqual(events.filter((event) => event.type === 'session.updated').at(-1).properties.info.metadata.nnd.turnState,
    { phase: 'running_tool' });
  output({ type: 'stream_delta', session_id: 'session_a', turn_id: 'turn_a', delta_type: 'text', text: 'hello' });
  assert.deepEqual(host.get('session_a', owner).metadata.nnd.turnState, { phase: 'streaming' });
  assert.ok(events.some((event) => event.type === 'message.part.updated' && event.properties.part.text === 'hello'),
    'phase updates must not swallow the live text preview');
  output({ type: 'tool_status', session_id: 'session_a', turn_id: 'turn_a', status: 'review_pending',
    tool: 'fs.write', tool_request_id: 'tool_a' });
  assert.deepEqual(host.get('session_a', owner).metadata.nnd.turnState, { phase: 'awaiting_approval' });
  output({ type: 'tool_status', session_id: 'session_a', turn_id: 'turn_a', status: 'running',
    tool: 'fs.write', tool_request_id: 'tool_a' });
  assert.deepEqual(host.get('session_a', owner).metadata.nnd.turnState, { phase: 'running_tool' });
  assert.deepEqual(host.get('session_a', owner).metadata.nnd.activeTools, { count: 1, names: ['fs.write'] });
  assert.ok(events.some((event) => event.type === 'nnd.activity' && event.properties.id === 'session_a:ts:tool_a'),
    'phase updates must not swallow tool activity');
  const firstRunningStamp = host.get('session_a', owner).time.updated;
  output({ type: 'tool_status', session_id: 'session_a', turn_id: 'turn_a', status: 'succeeded',
    tool: 'fs.write', tool_request_id: 'tool_a' });
  assert.deepEqual(host.get('session_a', owner).metadata.nnd.activeTools, { count: 0, names: [] });
  assert.equal(host.get('session_a', owner).metadata.nnd.turnState, undefined);
  assert.ok(host.get('session_a', owner).time.updated > firstRunningStamp,
    'terminal tool snapshot must outrank a stale running snapshot even when phase is unchanged');
  output({ type: 'tool_status', session_id: 'session_a', turn_id: 'turn_a', status: 'running', tool: 'fs.write' });
  assert.equal(host.get('session_a', owner).metadata.nnd.activeTools, undefined);
  assert.deepEqual(host.get('session_a', owner).metadata.nnd.turnState, { phase: 'running_tool' });
  output({ type: 'tool_status', session_id: 'session_a', turn_id: 'turn_a', status: 'succeeded', tool: 'fs.write' });
  assert.equal(host.get('session_a', owner).metadata.nnd.turnState, undefined);
  output({ type: 'tool_status', session_id: 'session_a', turn_id: 'turn_a', status: 'running',
    tool: 'fs.write', tool_request_id: 'tool_b' });
  const runningStamp = host.get('session_a', owner).time.updated;
  resolveTurn({ accepted: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(host.get('session_a', owner).metadata.nnd.turnState, { phase: 'idle' });
  assert.equal(host.get('session_a', owner).metadata.nnd.activeTools, undefined);
  assert.ok(host.get('session_a', owner).time.updated > runningStamp,
    'settled phase must outrank an in-flight prior session snapshot');
  await host.shutdown();
});

test('NND engine surface emits the engine semantic state without exposing it on headless', async () => {
  const records = [];
  await emitEngineStatus({ surface: 'nnd', sessionId: 's1', output: (record) => records.push(record) }, 'preparing', { turnId: 't1' });
  await emitEngineStatus({ surface: 'headless', sessionId: 's1', output: (record) => records.push(record) }, 'preparing', { turnId: 't1' });
  assert.deepEqual(records, [{ version: '1.0', type: 'state_status', session_id: 's1', turn_id: 't1', semantic_state: 'preparing' }]);
});

test('NND durable catalog restores owned sessions and removes closed sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-nnd-catalog-'));
  const catalogPath = join(root, 'nnd-contexts.json');
  const makeHost = () => new NndEngineHost({ catalogPath, createEngine: async () => fakeEngine() });
  const first = makeHost();
  await first.initialize();
  await first.create('session_a', owner, { title: 'Continued work' });
  await first.shutdown();
  const second = makeHost();
  await second.initialize();
  assert.deepEqual(second.list(owner).map((session) => session.title), ['Continued work']);
  assert.equal(second.get('session_a', owner).id, 'session_a');
  assert.deepEqual(second.list({ subjectId: 'other', workspaceIds: owner.workspaceIds }), []);
  await second.close('session_a', owner);
  assert.deepEqual(JSON.parse(await readFile(catalogPath, 'utf8')), []);
});

test('NND durable catalog refuses malformed records without discarding them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-nnd-catalog-invalid-'));
  const catalogPath = join(root, 'nnd-contexts.json');
  await writeFile(catalogPath, '[{"sessionId":"../escape"}]');
  const host = new NndEngineHost({ catalogPath, createEngine: async () => fakeEngine() });
  await assert.rejects(host.initialize(), { code: 'nnd_catalog_invalid' });
  assert.match(await readFile(catalogPath, 'utf8'), /escape/u);
});

test('NND restores only the last classified numeric context observation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-nnd-context-'));
  const catalogPath = join(root, 'catalog.json');
  let output; let release;
  const engine = fakeEngine();
  engine.transcript = [];
  engine.submit = async () => new Promise((resolve) => { release = resolve; });
  const first = new NndEngineHost({ catalogPath, createEngine: async (options) => {
    output = options.output; return engine;
  } });
  await first.create('session_a', owner);
  first.submitAsync('session_a', { version: '1.0', type: 'submit', request_id: 'prompt_a', content: 'hello' }, owner);
  output({ type: 'context_status', session_id: 'session_a', turn_id: 'turn_a',
    estimated_tokens: 4_000, limit_tokens: 16_000, source_text: 'private context' });
  output({ type: 'context_usage', session_id: 'session_a', turn_id: 'turn_a',
    current_estimated_tokens: 5_000, limit_tokens: 16_000, source_text: 'private context' });
  release({ accepted: true });
  await new Promise((resolve) => setImmediate(resolve));
  await first.catalogWrites;
  const catalog = await readFile(catalogPath, 'utf8');
  assert.equal(catalog.includes('private context'), false);
  assert.equal(JSON.parse(catalog)[0].contextUsage.estimatedTokens, 5_000);
  await first.shutdown();
  const second = new NndEngineHost({ catalogPath, createEngine: async () => fakeEngine() });
  await second.initialize();
  assert.deepEqual(second.get('session_a', owner).metadata.nnd.context,
    JSON.parse(catalog)[0].contextUsage);
  await second.shutdown();
  const corrupt = JSON.parse(catalog);
  corrupt[0].contextUsage.secret = 'do-not-project';
  await writeFile(catalogPath, JSON.stringify(corrupt));
  const third = new NndEngineHost({ catalogPath, createEngine: async () => fakeEngine() });
  await assert.rejects(third.initialize(), { code: 'nnd_catalog_invalid' });
  assert.match(await readFile(catalogPath, 'utf8'), /do-not-project/u);
});

test('a failed context estimate save is visible but does not fail the governed turn', async () => {
  let output; let release; let writes = 0;
  const engine = fakeEngine();
  engine.transcript = [];
  engine.submit = async () => new Promise((resolve) => { release = resolve; });
  const host = new NndEngineHost({ catalogPath: 'test-catalog',
    persistCatalog: async () => { if (++writes === 2) throw new Error('disk full'); },
    persistActivity: async () => {},
    createEngine: async (options) => { output = options.output; return engine; } });
  await host.create('session_a', owner);
  host.submitAsync('session_a', { version: '1.0', type: 'submit', request_id: 'prompt_a', content: 'hello' }, owner);
  output({ type: 'context_status', session_id: 'session_a', turn_id: 'turn_a',
    estimated_tokens: 100, limit_tokens: 1_000 });
  release({ accepted: true });
  await new Promise((resolve) => setImmediate(resolve));
  await host.catalogWrites.catch(() => undefined);
  assert.equal(host.activity('session_a', owner).some((row) => row.summary === 'Context estimate could not be saved'), true);
  assert.equal(host.activity('session_a', owner).some((row) => row.summary === 'Turn completed'), true);
  await host.shutdown();
});

test('NND activity snapshot reopens after restart and requires the complete owner grant', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-nnd-activity-'));
  const catalogPath = join(root, 'catalog.json');
  let output;
  let release;
  const first = new NndEngineHost({ catalogPath, createEngine: async (options) => {
    output = options.output;
    const engine = fakeEngine();
    engine.transcript = [];
    engine.submit = async () => new Promise((resolve) => { release = resolve; });
    return engine;
  } });
  const fullOwner = { subjectId: owner.subjectId, workspaceIds: ['workspace_a', 'workspace_b'] };
  await first.create('session_a', fullOwner);
  first.submitAsync('session_a', { version: '1.0', type: 'submit', request_id: 'prompt_a', content: 'hello' }, fullOwner);
  output({ type: 'state_status', session_id: 'session_a', semantic_state: 'waiting_provider',
    provider_payload: 'do-not-persist' });
  output({ type: 'tool_status', session_id: 'session_a', tool_request_id: 'tool_a',
    tool: 'shell_run', status: 'running', arguments: { secret: 'do-not-persist' } });
  output({ type: 'tool_status', session_id: 'session_a', tool_request_id: 'tool_a',
    tool: 'shell_run', status: 'succeeded', target: 'powershell: Invoke-Task private-command-123', effect: 'read_only',
    elapsed_ms: 25, exit_code: 0, arguments: { secret: 'do-not-persist' } });
  release({ accepted: true });
  await new Promise((resolve) => setImmediate(resolve));
  first.submitAsync('session_a', { version: '1.0', type: 'submit', request_id: 'prompt_b', content: 'again' }, fullOwner);
  output({ type: 'state_status', session_id: 'session_a', semantic_state: 'waiting_provider',
    provider_payload: 'do-not-persist' });
  release({ accepted: true });
  await new Promise((resolve) => setImmediate(resolve));
  const before = first.activity('session_a', fullOwner);
  assert.deepEqual(before.filter((record) => record.kind === 'state').map((record) =>
    [record.summary, record.evidenceMessageID]), [
    ['Waiting for model', 'prompt_a'], ['Running tool', 'prompt_a'], ['Waiting for model', 'prompt_b'],
  ]);
  assert.equal(new Set(before.filter((record) => record.kind === 'state').map((record) => record.id)).size, 3);
  assert.equal(before.filter((record) => record.kind === 'tool').at(-1).status, 'completed');
  assert.deepEqual(before.filter((record) => record.kind === 'tool').at(-1).toolEvidence,
    { effect: 'read_only', elapsedMs: 25, exitCode: 0, turnRequestID: 'prompt_a' });
  assert.deepEqual(before.filter((record) => record.kind === 'turn' && record.status === 'completed')
    .map((record) => record.evidenceMessageID), ['prompt_a', 'prompt_b']);
  assert.equal(before.find((record) => record.kind === 'tool').evidenceMessageID, undefined);
  assert.throws(() => first.activity('session_a', owner), { code: 'nnd_session_unavailable' });
  await first.shutdown();
  const stored = await readFile(activityPath(catalogPath, 'session_a'), 'utf8');
  assert.equal(stored.includes('do-not-persist'), false);
  assert.equal(stored.includes('private-command-123'), false);
  const altered = JSON.parse(stored);
  altered.records[0].extraSecret = 'must-not-project';
  await writeFile(activityPath(catalogPath, 'session_a'), JSON.stringify(altered));
  const reopened = new NndEngineHost({ catalogPath, createEngine: async () => fakeEngine() });
  await reopened.initialize();
  assert.deepEqual(reopened.activity('session_a', fullOwner), before);
  await reopened.close('session_a', fullOwner);
  await assert.rejects(readFile(activityPath(catalogPath, 'session_a'), 'utf8'), { code: 'ENOENT' });
});

test('NND Activity stores file path targets but never arbitrary command, query, or task text', () => {
  const records = [];
  const base = { id: 'activity', sessionID: 'session_a', time: 1, kind: 'tool', status: 'completed', summary: 'tool complete' };
  const file = appendActivity(records, { ...base, toolEvidence: { tool: 'fs_read_text', target: 'D:/work/check.js' } });
  assert.deepEqual(file.toolEvidence, { target: 'D:/work/check.js' });
  for (const tool of ['shell_run', 'process_run', 'agent_run', 'project_verify', 'fs_search_text', 'unknown_extension']) {
    const result = appendActivity(records, { ...base, id: tool, toolEvidence: {
      tool, target: 'private-command-123', arguments: { token: 'do-not-persist' },
      effect: 'read_only', elapsed_ms: 4,
    } });
    assert.deepEqual(result.toolEvidence, { effect: 'read_only', elapsedMs: 4 });
  }
  assert.equal(JSON.stringify(records).includes('private-command-123'), false);
  assert.equal(JSON.stringify(records).includes('do-not-persist'), false);
});

test('NND Activity projects only succeeded workspace file mutations as review paths', () => {
  const records = [];
  const base = { id: 'review', sessionID: 'session_a', time: 1, kind: 'tool', status: 'completed', summary: 'file edited' };
  const mutation = appendActivity(records, { ...base, toolEvidence: {
    tool: 'fs_edit_text', status: 'succeeded', review_path: 'src/check.js',
    review_workspace: 'D:/work', target: 'src/check.js',
  } });
  assert.deepEqual(mutation.toolEvidence, { target: 'src/check.js', reviewPath: 'src/check.js', reviewDirectory: 'D:/work' });
  for (const [tool, status, path] of [
    ['fs_read_text', 'succeeded', 'src/check.js'], ['fs_edit_text', 'running', 'src/check.js'],
    ['fs_edit_text', 'succeeded', '../outside.js'], ['fs_edit_text', 'succeeded', 'D:/outside.js'],
    ['fs_edit_text', 'succeeded', 'src\\outside.js'],
  ]) {
    const result = appendActivity(records, { ...base, id: `${tool}:${status}:${path}`, toolEvidence: {
      tool, status, review_path: path, review_workspace: 'D:/work',
    } });
    assert.equal(result.toolEvidence?.reviewPath, undefined);
  }
  const unbound = appendActivity(records, { ...base, id: 'unbound', toolEvidence: {
    tool: 'fs_edit_text', status: 'succeeded', review_path: 'src/check.js',
  } });
  assert.equal(unbound.toolEvidence?.reviewPath, undefined);
});

test('tool status derives review path from a resolved in-workspace mutation, not caller arguments', () => {
  const root = join(tmpdir(), 'review-root');
  const engine = { sessionId: 'session_a', config: { workspaceRoot: root },
    tools: { definition: () => ({ sideEffect: 'reversible', scope: 'workspace' }) } };
  const item = { request: { id: 'tool_a', toolName: 'fs_edit_text', args: { path: '../outside.js' },
    resolved: { path: join(root, 'src', 'check.js'), insideWorkspace: true } },
  call: { name: 'fs_edit_text' } };
  assert.equal(toolStatus(engine, { turnId: 'turn_a' }, item, 'succeeded').review_path, 'src/check.js');
  assert.equal(toolStatus(engine, { turnId: 'turn_a' }, item, 'succeeded').review_workspace, root);
  assert.equal(toolStatus(engine, { turnId: 'turn_a' }, item, 'running').review_path, null);
  item.request.resolved.path = join(root, '..', 'outside.js');
  assert.equal(toolStatus(engine, { turnId: 'turn_a' }, item, 'succeeded').review_path, null);
});

test('NND activity rejects corrupt durable snapshots instead of silently clearing evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-nnd-activity-invalid-'));
  const catalogPath = join(root, 'catalog.json');
  const first = new NndEngineHost({ catalogPath, createEngine: async () => fakeEngine() });
  await first.create('session_a', owner);
  await first.shutdown();
  const path = activityPath(catalogPath, 'session_a');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '{"version":1,"records":[{"summary":"private"}]}');
  const reopened = new NndEngineHost({ catalogPath, createEngine: async () => fakeEngine() });
  await assert.rejects(reopened.initialize(), { code: 'nnd_activity_invalid' });
  assert.match(await readFile(path, 'utf8'), /private/u);
});

test('NND activity write failure cannot fail a governed turn and a later event retries', async () => {
  let release;
  let writes = 0;
  const engine = fakeEngine();
  engine.transcript = [];
  engine.submit = async () => new Promise((resolve) => { release = resolve; });
  const host = new NndEngineHost({ catalogPath: 'test-catalog', createEngine: async () => engine,
    persistCatalog: async () => {}, persistActivity: async () => {
      writes += 1;
      if (writes === 1) throw new Error('disk full');
    } });
  await host.create('session_a', owner);
  assert.equal(host.submitAsync('session_a', { version: '1.0', type: 'submit', request_id: 'prompt_a', content: 'hello' }, owner).accepted, true);
  release({ accepted: true });
  await new Promise((resolve) => setImmediate(resolve));
  await host.shutdown();
  assert.equal(host.activity('session_a', owner).at(-1).status, 'completed');
  assert.ok(writes >= 2);
});

test('NND activity bounds and sanitizes retained records with monotonic update time', () => {
  const records = [];
  const first = appendActivity(records, { id: 'turn_a', sessionID: 'session_a', kind: 'turn',
    status: 'started', summary: 'first\nsecret' });
  const updated = appendActivity(records, { id: 'turn_a', sessionID: 'session_a', kind: 'turn',
    status: 'completed', summary: 'done' });
  assert.ok(updated.time > first.time);
  assert.equal(records[0].summary, 'done');
  assert.equal(appendActivity(records, { id: 'bad', sessionID: 'session_a', kind: 'tool', status: 'unknown', summary: 'bad' }), null);
  for (let index = 0; index < 520; index += 1) appendActivity(records, {
    id: `tool_${index}`, sessionID: 'session_a', kind: 'tool', status: 'completed', summary: 'x'.repeat(500),
  });
  assert.equal(records.length, 500);
  assert.equal(records.some((record) => record.id === 'turn_a'), false);
  assert.equal(records[0].summary.length, 256);
  const longestTurnId = `${'s'.repeat(128)}:turn:${'r'.repeat(128)}`;
  assert.equal(appendActivity(records, { id: longestTurnId, sessionID: 's'.repeat(128), kind: 'turn',
    status: 'started', summary: 'Turn started', evidenceMessageID: 'r'.repeat(128) })?.id, longestTurnId);
  assert.equal(appendActivity(records, { id: 'x'.repeat(265), sessionID: 'session_a', kind: 'turn',
    status: 'started', summary: 'Too long' }), null);
  assert.equal(appendActivity(records, { id: 'tool-evidence', sessionID: 'session_a', kind: 'tool',
    status: 'completed', summary: 'Tool complete', evidenceMessageID: 'prompt_a' })?.evidenceMessageID, undefined);
});

test('NND live Activity matches sanitized snapshots and drops invalid frames', async () => {
  const events = [];
  let output;
  const host = new NndEngineHost({ eventBus: { publishSession: (event) => events.push(event) },
    createEngine: async (options) => { output = options.output; return { ...fakeEngine(), transcript: [],
      submit: async () => new Promise(() => {}) }; } });
  await host.create('session_a', owner);
  // Hold a turn open so two tool corrections are accepted by the output boundary.
  const context = host.submitAsync('session_a', { version: '1.0', type: 'submit', request_id: 'prompt_a', content: 'hello' }, owner);
  assert.equal(context.accepted, true);
  const originalNow = Date.now;
  Date.now = () => 1_000;
  try {
    output({ type: 'tool_status', session_id: 'session_a', tool_request_id: 'tool_a', tool: 'shell_run', status: 'running' });
    output({ type: 'tool_status', session_id: 'session_a', tool_request_id: 'tool_a', tool: 'shell_run', status: 'succeeded' });
    const rootSaved = host.activity('session_a', owner).filter((record) => record.kind === 'tool').at(-1);
    const rootLive = events.filter((event) => event.type === 'nnd.activity' && event.properties.kind === 'tool').at(-1).properties;
    assert.deepEqual(rootLive, rootSaved);
    const rootEvents = events.length;
    output({ type: 'tool_status', session_id: 'session_a', tool_request_id: 'x'.repeat(300),
      tool: 'shell_run', status: 'succeeded' });
    assert.equal(events.length, rootEvents);
    assert.equal(host.activity('session_a', owner).some((record) => record.id.includes('x'.repeat(300))), false);
    const child = { config: { workspaceRoot: 'D:\\work' }, active: { finalized: false }, transcript: [] };
    const finish = host.childSessions.register('agent_a', 'session_a', owner, child);
    host.childSessions.observeStarted('agent_a');
    const childEvents = events.length;
    host.childSessions.observeOutput('agent_a', { type: 'tool_status', session_id: 'agent_a',
      tool_request_id: 'x'.repeat(300), tool: 'shell_run', status: 'succeeded' });
    assert.equal(events.length, childEvents);
    finish('completed');
    const childSaved = host.activity('agent_a', owner).at(-1);
    const childLive = events.filter((event) => event.type === 'nnd.activity' && event.sessionID === 'agent_a').at(-1).properties;
    assert.deepEqual(childLive, childSaved);
  } finally { Date.now = originalNow; }
  await host.shutdown();
});

test('NND rename persists only after a successful catalog write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-nnd-rename-'));
  const catalogPath = join(root, 'nnd-contexts.json');
  const makeHost = () => new NndEngineHost({ catalogPath, createEngine: async () => fakeEngine() });
  const first = makeHost();
  await first.initialize();
  await first.create('session_a', owner, { title: 'Original' });
  const createdUpdatedAt = first.get('session_a', owner).time.updated;
  await assert.rejects(first.rename('session_a', owner, ''), { code: 'session_name_invalid' });
  assert.equal((await first.rename('session_a', owner, '  Renamed  ')).title, 'Renamed');
  assert.ok(first.get('session_a', owner).time.updated > createdUpdatedAt);
  await first.shutdown();
  const reopened = makeHost();
  await reopened.initialize();
  assert.equal(reopened.get('session_a', owner).title, 'Renamed');
  assert.equal(reopened.get('session_a', owner).time.updated, first.get('session_a', owner).time.updated);

  const failed = new NndEngineHost({ catalogPath: 'test-catalog', createEngine: async () => fakeEngine(),
    persistCatalog: async (_path, records) => {
      if (records[0]?.title === 'Uncommitted') throw new Error('write failed');
    },
  });
  await failed.create('session_b', owner, { title: 'Stable' });
  const stableUpdatedAt = failed.get('session_b', owner).time.updated;
  await assert.rejects(failed.rename('session_b', owner, 'Uncommitted'), /write failed/u);
  assert.equal(failed.get('session_b', owner).title, 'Stable');
  assert.equal(failed.get('session_b', owner).time.updated, stableUpdatedAt);
});

test('NND archive and restore retain durable list semantics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-nnd-archive-'));
  const catalogPath = join(root, 'nnd-contexts.json');
  const makeHost = () => new NndEngineHost({ catalogPath, createEngine: async () => fakeEngine() });
  const first = makeHost();
  await first.initialize();
  await first.create('session_a', owner);
  const createdUpdatedAt = first.get('session_a', owner).time.updated;
  await assert.rejects(first.setArchived('session_a', owner, -1), { code: 'request_invalid' });
  await first.setArchived('session_a', owner, 12345);
  assert.deepEqual(first.list(owner), []);
  assert.equal(first.list(owner, { includeArchived: true })[0].time.archived, 12345);
  const archivedUpdatedAt = first.get('session_a', owner).time.updated;
  assert.ok(archivedUpdatedAt > createdUpdatedAt);
  await first.shutdown();
  const reopened = makeHost();
  await reopened.initialize();
  assert.deepEqual(reopened.list(owner), []);
  assert.equal(reopened.list(owner, { includeArchived: true })[0].time.archived, 12345);
  assert.equal(reopened.get('session_a', owner).time.updated, archivedUpdatedAt);
  await reopened.setArchived('session_a', owner, 0);
  assert.equal(reopened.list(owner)[0].time.archived, undefined);
  assert.ok(reopened.get('session_a', owner).time.updated > archivedUpdatedAt);
});

test('NND session directory follows the initialized engine and later workspace transitions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-nnd-directory-'));
  const catalogPath = join(root, 'nnd-contexts.json');
  await writeFile(catalogPath, JSON.stringify([{
    sessionId: 'session_a', subjectId: owner.subjectId, workspaceIds: owner.workspaceIds,
    title: 'Older session', directory: '', createdAt: Date.now(),
  }]));
  let engine;
  const host = new NndEngineHost({ catalogPath, createEngine: async () => {
    const next = fakeEngine();
    next.config = { workspaceRoot: root };
    engine ??= next;
    return next;
  } });
  await host.initialize();
  assert.equal(host.get('session_a', owner).directory, root);
  assert.equal(host.get('session_a', owner).time.updated, host.get('session_a', owner).time.created);
  const nextRoot = join(root, 'next');
  engine.config = { workspaceRoot: nextRoot };
  assert.equal(host.list(owner)[0].directory, nextRoot);
  await host.create('session_b', owner);
  const records = JSON.parse(await readFile(catalogPath, 'utf8'));
  assert.equal(records.find((record) => record.sessionId === 'session_a').directory, nextRoot);
});

test('NND catalog excludes a failed concurrent create from the next durable write', async () => {
  let firstWrite;
  const firstStarted = new Promise((resolve) => { firstWrite = resolve; });
  let rejectFirst;
  const firstPending = new Promise((resolve, reject) => { rejectFirst = reject; });
  const durable = [];
  let writes = 0;
  const host = new NndEngineHost({ catalogPath: 'test-catalog', createEngine: async () => fakeEngine(),
    persistCatalog: async (_path, records) => {
      writes += 1;
      if (writes === 1) { firstWrite(); await firstPending; }
      durable.push(records.map((record) => record.sessionId));
    },
  });
  const failed = host.create('session_a', owner);
  await firstStarted;
  const accepted = host.create('session_b', owner);
  rejectFirst(new Error('catalog write failed'));
  await assert.rejects(failed, /catalog write failed/u);
  await accepted;
  assert.deepEqual(durable, [['session_b']]);
  assert.deepEqual(host.list(owner).map((session) => session.id), ['session_b']);
});

test('NND catalog retains a closing session while another session is created', async () => {
  const durable = [];
  let failClose = false;
  const host = new NndEngineHost({ catalogPath: 'test-catalog', createEngine: async () => fakeEngine(),
    persistCatalog: async (_path, records) => {
      if (failClose && records.every((record) => record.sessionId !== 'session_a')) throw new Error('catalog write failed');
      durable.push(records.map((record) => record.sessionId));
    },
  });
  await host.create('session_a', owner);
  failClose = true;
  await assert.rejects(host.close('session_a', owner), /catalog write failed/u);
  await host.create('session_b', owner);
  assert.deepEqual(durable.at(-1), ['session_a', 'session_b']);
});

test('NND catalog refuses a write that cannot be reopened within its size bound', async () => {
  let writes = 0;
  const host = new NndEngineHost({ catalogPath: 'test-catalog', createEngine: async () => fakeEngine(),
    persistCatalog: async () => { writes += 1; },
  });
  const largePrincipal = { subjectId: 'user_a', workspaceIds: Array.from({ length: 400 }, (_, index) => `${index}_${'x'.repeat(250)}`) };
  for (let index = 0; index < 9; index += 1) await host.create(`session_${index}`, largePrincipal);
  await assert.rejects(host.create('session_9', largePrincipal), { code: 'nnd_catalog_capacity' });
  assert.equal(writes, 9);
  assert.equal(host.list(largePrincipal).length, 9);
});

test('NND engine host binds each context to its authenticated owner', async () => {
  const created = [];
  const host = new NndEngineHost({ createEngine: async (options) => {
    created.push(options);
    return fakeEngine();
  } });
  await host.create('session_a', owner);
  assert.equal(created[0].nndSessionRegistry, host.childSessions);
  await assert.rejects(() => host.submit('session_a', steer('request_a'), { subjectId: 'user_b', workspaceIds: ['workspace_a'] }), { code: 'nnd_session_unavailable' });
  assert.deepEqual(await host.submit('session_a', steer('request_a'), owner), { accepted: true, request_id: 'request_a' });
  assert.deepEqual(await host.close('session_a', owner), { closed: true });
  await assert.rejects(() => host.submit('session_a', steer('request_b'), owner), { code: 'nnd_session_unavailable' });
});

test('NND engine host requires the entire original workspace grant', async () => {
  const events = [];
  const host = new NndEngineHost({ createEngine: async () => fakeEngine(),
    eventBus: { publishSession: (event) => events.push(event) } });
  await host.create('session_a', { subjectId: 'user_a', workspaceIds: ['workspace_a', 'workspace_b'] });
  assert.deepEqual(events[0].workspaceIds, ['workspace_a', 'workspace_b']);
  assert.throws(
    () => host.get('session_a', { subjectId: 'user_a', workspaceIds: ['workspace_b'] }),
    { code: 'nnd_session_unavailable' },
  );
});

test('NND engine host lists child sessions and projects their retained transcripts', async () => {
  const host = new NndEngineHost({ createEngine: async () => fakeEngine() });
  await host.create('session_a', owner);
  const child = { config: { workspaceRoot: 'D:\\work' }, active: { finalized: false }, transcript: [
    { type: 'message', role: 'user', content: 'Inspect this' },
    { type: 'message', role: 'assistant', content: 'Done' },
  ] };
  child.config.routes = { primary: { providerId: 'child-provider', model: 'child-model', credential: 'private child credential' } };
  const stop = host.childSessions.register('agent_coder_1', 'session_a', owner, child, { type: 'coder' });
  assert.equal(host.list(owner).length, 2);
  assert.deepEqual(host.list(owner, { roots: true }).map((session) => session.id), ['session_a']);
  assert.deepEqual(host.list(owner, { roots: false }).map((session) => session.id), ['agent_coder_1']);
  assert.deepEqual(host.list(owner, { limit: 1 }).map((session) => session.id), ['session_a']);
  assert.throws(() => host.list(owner, { limit: 0 }), { code: 'request_invalid' });
  assert.deepEqual(host.listChildren('session_a', owner).map((session) => session.id), ['agent_coder_1']);
  assert.deepEqual(host.listChildren('agent_coder_1', owner), []);
  assert.throws(() => host.listChildren('session_a', { subjectId: 'other', workspaceIds: owner.workspaceIds }),
    { code: 'nnd_session_unavailable' });
  assert.equal(host.get('agent_coder_1', owner).parentID, 'session_a');
  assert.equal(host.get('agent_coder_1', owner).agent, 'coder');
  assert.deepEqual(host.get('agent_coder_1', owner).metadata.nnd.configuredModel,
    { providerID: 'child-provider', modelID: 'child-model' });
  assert.equal(JSON.stringify(host.list(owner)).includes('private child credential'), false);
  assert.equal(host.statuses(owner).agent_coder_1.type, 'busy');
  assert.deepEqual(host.messages('agent_coder_1', owner).map(({ info, parts }) => [info.id, parts[0].text]), [
    ['agent_coder_1:message:0', 'Inspect this'], ['agent_coder_1:message:1', 'Done'],
  ]);
  stop();
  assert.equal(host.get('agent_coder_1', owner).agent, 'coder');
  assert.deepEqual(host.get('agent_coder_1', owner).metadata.nnd.configuredModel,
    { providerID: 'child-provider', modelID: 'child-model' });
  assert.deepEqual(host.statuses(owner), {});
  assert.equal(host.messages('agent_coder_1', owner)[1].parts[0].text, 'Done');
  await host.close('session_a', owner);
  assert.equal(host.list(owner).length, 0);
  assert.throws(() => host.listChildren('session_a', owner), { code: 'nnd_session_unavailable' });
  assert.throws(() => host.messages('agent_coder_1', owner), { code: 'nnd_session_unavailable' });
});

test('NND session lists apply the limit after stable filtering and ordering', async () => {
  const host = new NndEngineHost({ createEngine: async () => fakeEngine() });
  await host.create('session_z', owner);
  await host.create('session_a', owner);
  const child = { config: { workspaceRoot: 'D:\\work' }, active: null, transcript: [] };
  host.childSessions.register('agent_z', 'session_a', owner, child);
  host.childSessions.register('agent_a', 'session_a', owner, child);
  assert.deepEqual(host.list(owner, { roots: true, limit: 1 }).map((session) => session.id), ['session_a']);
  assert.deepEqual(host.list(owner, { roots: false, limit: 1 }).map((session) => session.id), ['agent_a']);
  assert.deepEqual(host.listChildren('session_a', owner).map((session) => session.id), ['agent_a', 'agent_z']);
  assert.deepEqual(host.list(owner, { limit: 3 }).map((session) => session.id), ['session_a', 'session_z', 'agent_a']);
});

test('NND child sessions stream text and reconcile to the retained transcript', async () => {
  const events = [];
  const principal = { subjectId: 'user_a', workspaceIds: ['workspace_a', 'workspace_b'] };
  const host = new NndEngineHost({ eventBus: { publishSession: (event) => events.push(event) },
    createEngine: async () => fakeEngine() });
  await host.create('session_a', principal);
  const child = { config: { workspaceRoot: 'D:\\work' }, active: { finalized: false }, transcript: [
    { type: 'message', role: 'user', content: 'Inspect this' },
  ] };
  const stop = host.childSessions.register('agent_coder_1', 'session_a', principal, child, { type: 'coder' });
  host.childSessions.observeStarted('agent_coder_1');
  assert.deepEqual(host.activity('agent_coder_1', principal).map((record) => record.status), ['started']);
  host.childSessions.observeOutput('agent_coder_1', { type: 'state_status', session_id: 'agent_coder_1',
    turn_id: 'turn_a', semantic_state: 'waiting_provider' });
  assert.deepEqual(host.get('agent_coder_1', principal).metadata.nnd.turnState, { phase: 'waiting_provider' });
  assert.deepEqual(host.activity('agent_coder_1', principal).filter((record) => record.kind === 'state').map((record) => record.summary), ['Waiting for model']);
  host.childSessions.observeOutput('agent_coder_1', { type: 'tool_status', session_id: 'agent_coder_1',
    turn_id: 'turn_a', tool_request_id: 'tool_a', tool: 'shell_run', status: 'running', arguments: { secret: 'private' } });
  assert.deepEqual(host.get('agent_coder_1', principal).metadata.nnd.activeTools, { count: 1, names: ['shell_run'] });
  assert.equal(JSON.stringify(events.filter((event) => event.type === 'session.updated')).includes('private'), false);
  host.childSessions.observeOutput('agent_coder_1', { type: 'tool_status', session_id: 'agent_coder_1',
    turn_id: 'turn_a', tool_request_id: 'tool_a', tool: 'shell_run', status: 'succeeded' });
  assert.deepEqual(host.get('agent_coder_1', principal).metadata.nnd.activeTools, { count: 0, names: [] });
  assert.equal(host.get('agent_coder_1', principal).metadata?.nnd?.turnState, undefined);
  host.childSessions.observeOutput('agent_coder_1', { type: 'tool_status', session_id: 'agent_coder_1',
    turn_id: 'turn_a', tool: 'shell_run', status: 'running' });
  assert.equal(host.get('agent_coder_1', principal).metadata.nnd.activeTools, undefined);
  assert.deepEqual(host.get('agent_coder_1', principal).metadata.nnd.turnState, { phase: 'running_tool' });
  host.childSessions.observeOutput('agent_coder_1', { type: 'tool_status', session_id: 'agent_coder_1',
    turn_id: 'turn_a', tool: 'shell_run', status: 'succeeded' });
  assert.equal(host.get('agent_coder_1', principal).metadata?.nnd?.turnState, undefined);
  const waitingStamp = host.get('agent_coder_1', principal).time.updated;
  host.childSessions.observeOutput('agent_coder_1', { type: 'stream_delta', session_id: 'agent_coder_1', turn_id: 'turn_a', text: 'Hello' });
  assert.equal(host.messages('agent_coder_1', principal).at(-1).parts[0].text, 'Hello');
  host.childSessions.observeOutput('agent_coder_1', { type: 'stream_delta', session_id: 'other', turn_id: 'turn_a', text: 'secret' });
  assert.throws(() => host.activity('agent_coder_1', { subjectId: principal.subjectId, workspaceIds: ['workspace_a'] }),
    { code: 'nnd_session_unavailable' });
  host.childSessions.observeOutput('agent_coder_1', { type: 'stream_delta', session_id: 'agent_coder_1', turn_id: 'turn_a', text: ' world' });
  assert.equal(host.messages('agent_coder_1', principal).at(-1).parts[0].text, 'Hello world');
  assert.equal(events.find((event) => event.type === 'session.created' && event.properties.info.id === 'agent_coder_1').workspaceIds.length, 2);
  assert.deepEqual(events.filter((event) => event.type === 'message.part.delta').map((event) => event.properties.delta), [' world']);
  assert.equal(events.some((event) => JSON.stringify(event).includes('secret')), false);
  assert.equal(events.some((event) => event.type === 'message.removed'), false);
  child.transcript.push({ type: 'message', role: 'assistant', content: 'Hello world' });
  host.childSessions.observeOutput('agent_coder_1', { type: 'turn_result', session_id: 'agent_coder_1', turn_id: 'turn_a', outcome: 'completed' });
  stop('completed');
  assert.deepEqual(host.get('agent_coder_1', principal).metadata.nnd.turnState, { phase: 'idle' });
  assert.ok(host.get('agent_coder_1', principal).time.updated > waitingStamp);
  assert.ok(events.some((event) => event.type === 'session.updated' && event.properties.info.id === 'agent_coder_1'
    && event.properties.info.metadata?.nnd?.turnState?.phase === 'waiting_provider'));
  const removed = events.findIndex((event) => event.type === 'message.removed');
  const canonical = events.findIndex((event, index) => index > removed && event.type === 'message.updated' && event.properties.info.id === 'agent_coder_1:message:1');
  assert.ok(removed > 0 && canonical > removed);
  assert.equal(events.at(-1).type, 'session.updated');
  assert.equal(host.messages('agent_coder_1', principal)[1].parts[0].text, 'Hello world');
  assert.equal(host.messages('agent_coder_1', principal).some((entry) => entry.info.id === 'agent_coder_1:live'), false);
  assert.deepEqual(host.activity('agent_coder_1', principal).map((record) => record.status),
    ['started', 'started', 'started', 'started', 'completed', 'completed']);
  await host.close('session_a', principal);
  assert.throws(() => host.activity('agent_coder_1', principal), { code: 'nnd_session_unavailable' });
  assert.deepEqual(events.slice(-2).map((event) => event.type), ['session.deleted', 'session.deleted']);
});

test('NND completed child transcript survives restart as read-only owned history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-nnd-child-'));
  const catalogPath = join(root, 'catalog.json');
  const principal = { subjectId: owner.subjectId, workspaceIds: ['workspace_a', 'workspace_b'] };
  const makeHost = () => new NndEngineHost({ catalogPath, createEngine: async () => fakeEngine() });
  const first = makeHost();
  await first.create('session_a', principal);
  const child = { config: { workspaceRoot: 'D:\\work', routes: { primary: {
    providerId: 'local', model: 'child-model', credential: 'do-not-save',
  } } }, active: { finalized: false }, transcript: [
    { type: 'message', role: 'user', content: 'Inspect this', privateField: 'do-not-save' },
    { type: 'message', role: 'assistant', content: 'Done', toolArguments: 'do-not-save' },
  ] };
  const finish = first.childSessions.register('agent_a', 'session_a', principal, child, { type: 'coder' });
  first.childSessions.observeStarted('agent_a');
  first.childSessions.observeOutput('agent_a', { type: 'state_status', session_id: 'agent_a',
    turn_id: 'turn_a', semantic_state: 'waiting_provider', provider_payload: 'do-not-save' });
  first.childSessions.observeOutput('agent_a', { type: 'tool_status', session_id: 'agent_a',
    tool_request_id: 'tool_a', tool: 'fs_read_text', status: 'running', arguments: 'do-not-save' });
  first.childSessions.observeOutput('agent_a', { type: 'tool_status', session_id: 'agent_a',
    tool_request_id: 'tool_a', tool: 'fs_read_text', status: 'succeeded', arguments: 'do-not-save',
    target: 'D:/work/readme.md', elapsed_ms: 4 });
  finish('completed');
  const beforeActivity = first.activity('agent_a', principal);
  assert.deepEqual(beforeActivity.map((row) => row.status),
    ['started', 'started', 'started', 'started', 'completed', 'completed']);
  assert.deepEqual(beforeActivity.filter((row) => row.kind === 'state').map((row) => row.summary),
    ['Waiting for model', 'Running tool']);
  assert.deepEqual(beforeActivity.filter((record) => record.kind === 'tool').at(-1).toolEvidence,
    { target: 'D:/work/readme.md', elapsedMs: 4 });
  await first.shutdown();
  const path = childSnapshotPath(catalogPath, 'agent_a');
  const saved = await readFile(path, 'utf8');
  assert.equal(saved.includes('do-not-save'), false);
  const second = makeHost();
  await second.initialize();
  assert.deepEqual(second.listChildren('session_a', principal).map((session) => session.id), ['agent_a']);
  assert.equal(second.get('agent_a', principal).agent, 'coder');
  assert.equal(second.get('agent_a', principal).metadata.nnd.configuredModel.modelID, 'child-model');
  assert.deepEqual(second.get('agent_a', principal).metadata.nnd.turnState, { phase: 'idle' });
  assert.deepEqual(second.messages('agent_a', principal).map((message) => message.parts[0].text), ['Inspect this', 'Done']);
  assert.deepEqual(second.messages('agent_a', principal).map((message) => message.info.id),
    ['agent_a:message:0', 'agent_a:message:1']);
  assert.deepEqual(second.activity('agent_a', principal), beforeActivity);
  assert.deepEqual(second.activity('agent_a', principal).filter((row) => row.kind === 'state').map((row) => row.summary),
    ['Waiting for model', 'Running tool']);
  assert.throws(() => second.activity('agent_a', owner), { code: 'nnd_session_unavailable' });
  assert.deepEqual(second.statuses(principal), {});
  assert.equal((await second.resolveChildSession('agent_a', principal)).availability, 'unavailable');
  assert.throws(() => second.get('agent_a', owner), { code: 'nnd_session_unavailable' });
  assert.throws(() => second.messages('agent_a', owner), { code: 'nnd_session_unavailable' });
  assert.deepEqual(second.list({ subjectId: 'other', workspaceIds: principal.workspaceIds }), []);
  await second.close('session_a', principal);
  await assert.rejects(readFile(path, 'utf8'), { code: 'ENOENT' });
});

test('NND retained child needs-input attention survives restart without claiming steering authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-nnd-child-attention-'));
  const catalogPath = join(root, 'catalog.json');
  const first = new NndEngineHost({ catalogPath, createEngine: async () => fakeEngine() });
  await first.create('session_a', owner);
  const child = { config: { workspaceRoot: root }, active: { finalized: false }, transcript: [] };
  const finish = first.childSessions.register('agent_a', 'session_a', owner, child);
  first.childSessions.observeStarted('agent_a');
  first.childSessions.observeOutput('agent_a', { type: 'turn_result', session_id: 'agent_a', outcome: 'needs_input' });
  finish('needs_input');
  assert.deepEqual(first.get('agent_a', owner).metadata.nnd.attention, { kind: 'needs_input' });
  await first.shutdown();
  const second = new NndEngineHost({ catalogPath, createEngine: async () => fakeEngine() });
  await second.initialize();
  assert.deepEqual(second.get('agent_a', owner).metadata.nnd.attention, { kind: 'needs_input' });
  assert.equal((await second.resolveChildSession('agent_a', owner)).availability, 'unavailable');
});

test('NND child snapshots cannot attach to a recreated parent and reject corrupt retained history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-nnd-child-bind-'));
  const catalogPath = join(root, 'catalog.json');
  const first = new NndEngineHost({ catalogPath, createEngine: async () => fakeEngine() });
  await first.create('session_a', owner);
  const child = { config: { workspaceRoot: root }, active: null, transcript: [
    { type: 'message', role: 'assistant', content: 'history' },
  ] };
  first.childSessions.register('agent_a', 'session_a', owner, child)('completed');
  await first.shutdown();
  const path = childSnapshotPath(catalogPath, 'agent_a');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  const legacy = { ...saved };
  delete legacy.activity;
  await writeFile(path, JSON.stringify(legacy));
  const compatible = new NndEngineHost({ catalogPath, createEngine: async () => fakeEngine() });
  await compatible.initialize();
  assert.deepEqual(compatible.activity('agent_a', owner), []);
  await compatible.shutdown();
  await writeFile(path, '{invalid json');
  const corrupt = new NndEngineHost({ catalogPath, createEngine: async () => fakeEngine() });
  await assert.rejects(corrupt.initialize(), { code: 'nnd_child_snapshot_invalid' });
  assert.equal(await readFile(path, 'utf8'), '{invalid json');
  await writeFile(path, JSON.stringify({ ...saved, activity: [{ id: 'bad', sessionID: 'other',
    kind: 'tool', status: 'completed', summary: 'forged', time: Date.now() }] }));
  const forged = new NndEngineHost({ catalogPath, createEngine: async () => fakeEngine() });
  await assert.rejects(forged.initialize(), { code: 'nnd_child_snapshot_invalid' });
  await writeFile(path, JSON.stringify({ ...saved, parentCreatedAt: saved.parentCreatedAt - 1 }));
  const stale = new NndEngineHost({ catalogPath, createEngine: async () => fakeEngine() });
  await stale.initialize();
  assert.deepEqual(stale.listChildren('session_a', owner), []);
  await stale.shutdown();
});

test('NND restart reconciles a child snapshot left by interrupted cache eviction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-nnd-child-evict-'));
  const catalogPath = join(root, 'catalog.json');
  const makeHost = () => new NndEngineHost({ catalogPath, childSessionLimit: 1,
    createEngine: async () => fakeEngine() });
  const first = makeHost();
  await first.create('session_a', owner);
  const child = (content) => ({ config: { workspaceRoot: root }, active: null, transcript: [
    { type: 'message', role: 'assistant', content },
  ] });
  first.childSessions.register('agent_a', 'session_a', owner, child('Old result'))('completed');
  await first.childSnapshotStore.drain();
  const stalePath = childSnapshotPath(catalogPath, 'agent_a');
  const staleContent = await readFile(stalePath, 'utf8');
  first.childSessions.register('agent_b', 'session_a', owner, child('New result'))('completed');
  await first.shutdown();
  // Simulate a crash after registry eviction but before its queued file removal.
  await writeFile(stalePath, staleContent);
  const reopened = makeHost();
  await reopened.initialize();
  assert.deepEqual(reopened.listChildren('session_a', owner).map((session) => session.id), ['agent_b']);
  assert.equal(reopened.messages('agent_b', owner)[0].parts[0].text, 'New result');
  await assert.rejects(readFile(stalePath, 'utf8'), { code: 'ENOENT' });
  await reopened.shutdown();
});

test('NND child snapshot write failure does not fail delegated work', async () => {
  let writes = 0;
  const host = new NndEngineHost({ catalogPath: 'test-catalog', createEngine: async () => fakeEngine(),
    persistCatalog: async () => {}, persistChildSnapshot: async () => {
      writes += 1;
      throw new Error('disk full');
    } });
  await host.create('session_a', owner);
  const child = { config: { workspaceRoot: '' }, active: null, transcript: [
    { type: 'message', role: 'assistant', content: 'Done' },
  ] };
  const finish = host.childSessions.register('agent_a', 'session_a', owner, child);
  assert.doesNotThrow(() => finish('completed'));
  await host.shutdown();
  assert.equal(writes, 1);
  assert.equal(host.messages('agent_a', owner)[0].parts[0].text, 'Done');
});

test('NND child recovery accepts the full catalog owner grant without a narrower child-only cap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-nnd-child-grant-'));
  const catalogPath = join(root, 'catalog.json');
  const principal = { subjectId: owner.subjectId, workspaceIds: Array.from({ length: 300 }, (_, index) => `workspace_${index}`) };
  const makeHost = () => new NndEngineHost({ catalogPath, createEngine: async () => fakeEngine() });
  const first = makeHost();
  await first.create('session_a', principal);
  first.childSessions.register('agent_a', 'session_a', principal, {
    config: { workspaceRoot: root }, active: null,
    transcript: [{ type: 'message', role: 'assistant', content: 'Done' }],
  })('completed');
  await first.shutdown();
  const reopened = makeHost();
  await reopened.initialize();
  assert.equal(reopened.messages('agent_a', principal)[0].parts[0].text, 'Done');
  assert.throws(() => reopened.messages('agent_a', { ...principal, workspaceIds: principal.workspaceIds.slice(1) }),
    { code: 'nnd_session_unavailable' });
  await reopened.shutdown();
});

test('NND failed parent close retains completed child history until catalog deletion succeeds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-nnd-child-close-'));
  const catalogPath = join(root, 'catalog.json');
  let shutdownAttempts = 0;
  const host = new NndEngineHost({ catalogPath, createEngine: async () => ({
    ...fakeEngine(), async shutdown() {
      shutdownAttempts += 1;
      if (shutdownAttempts === 1) throw new Error('shutdown failed');
    },
  }) });
  await host.create('session_a', owner);
  const child = { config: { workspaceRoot: root }, active: null, transcript: [
    { type: 'message', role: 'assistant', content: 'Retained child result' },
  ] };
  host.childSessions.register('agent_a', 'session_a', owner, child)('completed');
  await host.childSnapshotStore.drain();
  const path = childSnapshotPath(catalogPath, 'agent_a');
  await assert.rejects(() => host.close('session_a', owner), /shutdown failed/u);
  assert.match(await readFile(path, 'utf8'), /Retained child result/u);
  assert.equal(host.childSessions.get('agent_a', owner), null);
  const reopened = new NndEngineHost({ catalogPath, createEngine: async () => fakeEngine() });
  await reopened.initialize();
  assert.equal(reopened.messages('agent_a', owner)[0].parts[0].text, 'Retained child result');
  await reopened.shutdown();
  assert.deepEqual(await host.close('session_a', owner), { closed: true });
  await assert.rejects(readFile(path, 'utf8'), { code: 'ENOENT' });
});

test('NND engine host reserves capacity during creation and cleans up a failed initialization', async () => {
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  let shutdowns = 0;
  const host = new NndEngineHost({ limit: 1, createEngine: async () => {
    await ready;
    return { ...fakeEngine(), async initialize() { throw new Error('initialization failed'); }, async shutdown() { shutdowns += 1; } };
  } });
  const creating = host.create('session_a', owner);
  await assert.rejects(() => host.create('session_b', owner), { code: 'nnd_context_capacity' });
  await assert.rejects(() => host.create('session_a', owner), { code: 'nnd_session_exists' });
  release();
  await assert.rejects(creating, /initialization failed/u);
  assert.equal(shutdowns, 1);
});

test('NND engine host revokes child grants and retains a failed close for retry', async () => {
  let shutdownAttempts = 0;
  let revoked = 0;
  const childSessions = { unregisterParent: (sessionId) => { assert.equal(sessionId, 'session_a'); revoked += 1; } };
  const host = new NndEngineHost({ childSessions, createEngine: async () => ({
    ...fakeEngine(), async shutdown() {
      shutdownAttempts += 1;
      if (shutdownAttempts === 1) throw new Error('shutdown failed');
    },
  }) });
  await host.create('session_a', owner);
  await assert.rejects(() => host.close('session_a', owner), /shutdown failed/u);
  assert.equal(revoked, 1);
  await assert.rejects(() => host.submit('session_a', steer('request_a'), owner), { code: 'nnd_session_unavailable' });
  assert.deepEqual(await host.close('session_a', owner), { closed: true });
});

test('NND engine host acknowledges prompt_async work and keeps transcript IDs stable', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const engine = fakeEngine();
  engine.transcript = [{ type: 'message', role: 'user', content: 'first' }];
  engine.submit = async () => pending;
  const host = new NndEngineHost({ createEngine: async () => engine });
  await host.create('session_a', owner);
  assert.deepEqual(host.submitAsync('session_a', { version: '1.0', type: 'submit', request_id: 'prompt_a', content: 'hello' }, owner), { accepted: true, request_id: 'prompt_a' });
  assert.deepEqual(host.submitAsync('session_a', { version: '1.0', type: 'submit', request_id: 'prompt_a', content: 'hello' }, owner), { accepted: false, duplicate: true, pending: true });
  engine.transcript.push(...Array.from({ length: 201 }, (_, index) => ({ type: 'message', role: index % 2 ? 'assistant' : 'user', content: `message ${index}` })));
  const messages = host.messages('session_a', owner);
  assert.equal(messages.length, 200);
  assert.equal(messages[0].info.id, 'session_a:message:2');
  release();
});

test('NND projection reconciles submitted user IDs and settles persisted assistant messages', async () => {
  const engine = fakeEngine();
  engine.transcript = [
    { type: 'message', role: 'user', content: 'same text', requestId: 'msg_first' },
    { type: 'message', role: 'assistant', content: 'first reply' },
    { type: 'message', role: 'user', content: 'same text', requestId: 'msg_second' },
    { type: 'message', role: 'assistant', content: 'second reply' },
  ];
  const host = new NndEngineHost({ createEngine: async () => engine });
  await host.create('session_a', owner);
  const projected = host.messages('session_a', owner);
  assert.deepEqual(projected.map((entry) => entry.info.id), [
    'msg_first', 'session_a:message:1', 'msg_second', 'session_a:message:3',
  ]);
  assert.ok(projected[1].info.time.completed >= projected[1].info.time.created);
  assert.ok(projected[3].info.time.completed >= projected[3].info.time.created);
  assert.equal(projected[0].info.time.completed, undefined);
});

test('NND restored transcript suppresses a retried prompt and rejects projected-ID collisions', async () => {
  const engine = fakeEngine();
  engine.transcript = [
    { type: 'message', role: 'user', content: 'first', requestId: 'msg_replayed' },
    { type: 'message', role: 'assistant', content: 'reply' },
  ];
  let submissions = 0;
  engine.submit = async () => { submissions += 1; return { accepted: true }; };
  const events = [];
  const host = new NndEngineHost({ createEngine: async () => engine,
    eventBus: { publishSession: (event) => events.push(event) } });
  await host.create('session_a', owner);
  assert.deepEqual(host.submitAsync('session_a', { version: '1.0', type: 'submit', request_id: 'msg_replayed', content: 'first' }, owner),
    { accepted: false, duplicate: true, pending: false });
  assert.throws(() => host.submitAsync('session_a', { version: '1.0', type: 'submit',
    request_id: 'session_a:message:9', content: 'second' }, owner), { code: 'nnd_message_id_reserved' });
  assert.equal(submissions, 0);
  assert.deepEqual(events.map((event) => event.type), ['session.created']);
  assert.equal(host.messages('session_a', owner).filter((entry) => entry.info.id === 'msg_replayed').length, 1);
});

test('NND engine host rejects a prompt while its engine has an active turn', async () => {
  const engine = fakeEngine();
  engine.active = { finalized: false };
  let submissions = 0;
  engine.submit = async () => { submissions += 1; };
  const host = new NndEngineHost({ createEngine: async () => engine });
  await host.create('session_a', owner);
  assert.deepEqual(host.submitAsync('session_a', { version: '1.0', type: 'submit', request_id: 'prompt_a', content: 'hello' }, owner), { accepted: false, reason: 'busy' });
  assert.equal(submissions, 0);
});

test('NND engine host publishes a busy-to-idle reconciliation sequence', async () => {
  let release;
  const events = [];
  const engine = fakeEngine();
  engine.transcript = [{ type: 'message', role: 'user', content: 'hello' }];
  engine.submit = async () => new Promise((resolve) => { release = resolve; });
  const host = new NndEngineHost({
    eventBus: { publishSession: (event) => events.push(event) },
    createEngine: async () => engine,
  });
  await host.create('session_a', owner);
  host.submitAsync('session_a', { version: '1.0', type: 'submit', request_id: 'prompt_a', content: 'hello' }, owner);
  release({ accepted: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.map((event) => event.type), [
    'session.created', 'session.status', 'nnd.activity', 'session.updated', 'message.updated', 'message.part.updated',
    'nnd.activity', 'session.status', 'session.idle', 'session.updated',
  ]);
  assert.equal(events[1].properties.status.type, 'busy');
  assert.equal(events[3].properties.info.metadata?.nnd?.attention, undefined);
  assert.equal(events.at(-3).properties.status.type, 'idle');
});

test('NND engine host streams text and tool activity before authoritative completion', async () => {
  let output;
  let release;
  const events = [];
  const engine = fakeEngine();
  engine.transcript = [{ type: 'message', role: 'user', content: 'hello' }];
  engine.submit = async () => new Promise((resolve) => { release = resolve; });
  const host = new NndEngineHost({
    eventBus: { publishSession: (event) => events.push(event) },
    createEngine: async (options) => { output = options.output; return engine; },
  });
  await host.create('session_a', owner);
  host.submitAsync('session_a', { version: '1.0', type: 'submit', request_id: 'prompt_a', content: 'hello' }, owner);
  output({ type: 'context_status', session_id: 'session_a', turn_id: 'turn_a',
    estimated_tokens: 4_000, limit_tokens: 16_000, source_text: 'never publish context text' });
  assert.deepEqual(host.get('session_a', owner).metadata.nnd.context,
    { estimatedTokens: 4_000, limitTokens: 16_000, measurement: 'estimated',
      observedAt: host.get('session_a', owner).metadata.nnd.context.observedAt });
  assert.equal(JSON.stringify(events).includes('never publish context text'), false);
  output({ type: 'context_usage', session_id: 'session_a', turn_id: 'turn_a',
    current_estimated_tokens: 5_000, limit_tokens: 16_000 });
  assert.equal(host.get('session_a', owner).metadata.nnd.context.estimatedTokens, 5_000);
  output({ type: 'stream_delta', session_id: 'different', turn_id: 'turn_a', text: 'private' });
  output({ type: 'stream_delta', session_id: 'session_a', turn_id: 'turn_a', text: 'Hello' });
  output({ type: 'stream_delta', session_id: 'session_a', turn_id: 'turn_b', text: 'wrong turn' });
  output({ type: 'stream_delta', session_id: 'session_a', turn_id: 'turn_a', text: ' world' });
  output({ type: 'tool_status', session_id: 'session_a', turn_id: 'turn_a', tool_request_id: 'tool_a', tool: 'shell_run', status: 'running', arguments: { secret: 'do-not-expose' } });
  output({ type: 'tool_status', session_id: 'session_a', turn_id: 'turn_a', tool_request_id: 'tool_a', tool: 'shell_run', status: 'succeeded' });
  assert.deepEqual(events.filter((event) => event.type === 'message.part.updated').map((event) => event.properties.part.text), ['Hello']);
  assert.deepEqual(events.filter((event) => event.type === 'message.part.delta').map((event) => event.properties.delta), [' world']);
  assert.equal(events.filter((event) => event.type === 'nnd.activity' && event.properties.kind === 'tool').at(-1).properties.status, 'completed');
  assert.equal(JSON.stringify(events).includes('do-not-expose'), false);
  assert.equal(events.some((event) => event.type === 'message.removed'), false);
  engine.transcript.push({ type: 'message', role: 'assistant', content: 'Hello world' });
  output({ type: 'turn_result', session_id: 'session_a', turn_id: 'turn_a', outcome: 'completed' });
  release({ accepted: true });
  await new Promise((resolve) => setImmediate(resolve));
  const removed = events.findIndex((event) => event.type === 'message.removed');
  const canonical = events.findIndex((event, index) => index > removed && event.type === 'message.updated' && event.properties.info.id === 'session_a:message:1');
  assert.ok(removed > 0 && canonical > removed);
  assert.equal(events.filter((event) => event.type === 'nnd.activity' && event.properties.kind === 'turn').at(-1).properties.status, 'completed');
});

test('NND live turn cannot be replaced before the engine marks itself active', async () => {
  let release;
  const events = [];
  const engine = fakeEngine();
  engine.transcript = [];
  let submissions = 0;
  engine.submit = async () => { submissions += 1; return new Promise((resolve) => { release = resolve; }); };
  const host = new NndEngineHost({
    eventBus: { publishSession: (event) => events.push(event) },
    createEngine: async () => engine,
  });
  await host.create('session_a', owner);
  const first = { version: '1.0', type: 'submit', request_id: 'prompt_a', content: 'hello' };
  assert.equal(host.submitAsync('session_a', first, owner).accepted, true);
  assert.deepEqual(host.submitAsync('session_a', { ...first, request_id: 'prompt_b' }, owner), { accepted: false, reason: 'busy' });
  assert.deepEqual(host.submitAsync('session_a', first, owner), { accepted: false, duplicate: true, pending: true });
  assert.equal(submissions, 1);
  assert.equal(events.filter((event) => event.type === 'session.idle').length, 0);
  release({ accepted: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.filter((event) => event.type === 'session.idle').length, 1);
});

test('NND preview is bounded and a failing subscriber cannot fail the governed turn', async () => {
  let output;
  let release;
  const events = [];
  const engine = fakeEngine();
  engine.transcript = [];
  engine.submit = async () => new Promise((resolve) => { release = resolve; });
  const host = new NndEngineHost({
    eventBus: { publishSession: (event) => {
      events.push(event);
      if (event.type === 'message.part.updated') throw new Error('subscriber broke');
    } },
    createEngine: async (options) => { output = options.output; return engine; },
  });
  await host.create('session_a', owner);
  const first = { version: '1.0', type: 'submit', request_id: 'prompt_a', content: 'hello' };
  assert.equal(host.submitAsync('session_a', first, owner).accepted, true);
  assert.doesNotThrow(() => output({ type: 'stream_delta', session_id: 'session_a', turn_id: 'turn_a', text: 'x'.repeat(300_000) }));
  assert.equal(events.find((event) => event.type === 'message.part.updated').properties.part.text.length, 262_144);
  assert.equal(events.filter((event) => event.type === 'nnd.activity' && event.properties.kind === 'notice').length, 1);
  output({ type: 'stream_delta', session_id: 'session_a', turn_id: 'turn_a', text: 'additional' });
  assert.equal(events.filter((event) => event.type === 'nnd.activity' && event.properties.kind === 'notice').length, 1);
  release({ accepted: false, reason: 'provider_failed' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.filter((event) => event.type === 'nnd.activity' && event.properties.kind === 'turn').at(-1).properties.status, 'failed');
  assert.equal(events.filter((event) => event.type === 'session.idle').length, 1);
});

test('NND activity does not label an intentional cancellation as a failure', async () => {
  let output;
  let release;
  const events = [];
  const engine = fakeEngine();
  engine.transcript = [];
  engine.submit = async () => new Promise((resolve) => { release = resolve; });
  const host = new NndEngineHost({
    eventBus: { publishSession: (event) => events.push(event) },
    createEngine: async (options) => { output = options.output; return engine; },
  });
  await host.create('session_a', owner);
  host.submitAsync('session_a', { version: '1.0', type: 'submit', request_id: 'prompt_a', content: 'hello' }, owner);
  output({ type: 'turn_result', session_id: 'session_a', turn_id: 'turn_a', outcome: 'cancelled' });
  release({ accepted: true });
  await new Promise((resolve) => setImmediate(resolve));
  const terminal = events.filter((event) => event.type === 'nnd.activity' && event.properties.kind === 'turn').at(-1).properties;
  assert.equal(terminal.status, 'completed');
  assert.equal(terminal.summary, 'Turn cancelled');
});

test('NND activity marks a governed needs-input outcome for operator attention', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-nnd-attention-'));
  const catalogPath = join(root, 'catalog.json');
  let output;
  let release;
  const events = [];
  const engine = fakeEngine();
  engine.transcript = [];
  engine.submit = async () => new Promise((resolve) => { release = resolve; });
  const host = new NndEngineHost({ catalogPath, eventBus: { publishSession: (event) => events.push(event) },
    createEngine: async (options) => { output = options.output; return engine; } });
  await host.create('session_a', owner);
  host.submitAsync('session_a', { version: '1.0', type: 'submit', request_id: 'prompt_a', content: 'hello' }, owner);
  output({ type: 'turn_result', session_id: 'session_a', turn_id: 'turn_a', outcome: 'needs_input' });
  release({ accepted: true });
  await new Promise((resolve) => setImmediate(resolve));
  const terminal = events.filter((event) => event.type === 'nnd.activity' && event.properties.kind === 'turn').at(-1).properties;
  assert.equal(terminal.status, 'attention');
  assert.equal(terminal.summary, 'Turn needs input');
  assert.equal(host.activity('session_a', owner).filter((record) => record.kind === 'turn').at(-1).status, 'attention');
  assert.deepEqual(host.get('session_a', owner).metadata.nnd.attention, { kind: 'needs_input' });
  await host.shutdown();
  let releaseNext;
  const resumedEvents = [];
  const restoredEngine = { ...fakeEngine(), transcript: [],
    submit: async () => new Promise((resolve) => { releaseNext = resolve; }) };
  const restored = new NndEngineHost({ catalogPath,
    eventBus: { publishSession: (event) => resumedEvents.push(event) },
    createEngine: async () => restoredEngine });
  await restored.initialize();
  assert.deepEqual(restored.get('session_a', owner).metadata.nnd.attention, { kind: 'needs_input' });
  assert.equal(restored.submitAsync('session_a', { version: '1.0', type: 'submit',
    request_id: 'prompt_b', content: 'continue' }, owner).accepted, true);
  assert.equal(restored.get('session_a', owner).metadata?.nnd?.attention, undefined);
  assert.equal(restored.list(owner)[0].metadata?.nnd?.attention, undefined);
  assert.equal(resumedEvents.find((event) => event.type === 'session.updated')?.properties.info.metadata?.nnd?.attention, undefined);
  releaseNext({ accepted: true });
  await new Promise((resolve) => setImmediate(resolve));
  await restored.shutdown();
});

test('NND activity reports a governed denial as a failed turn', async () => {
  let output;
  const events = [];
  const engine = fakeEngine();
  engine.transcript = [];
  engine.submit = async () => ({ accepted: true });
  const host = new NndEngineHost({
    eventBus: { publishSession: (event) => events.push(event) },
    createEngine: async (options) => { output = options.output; return engine; },
  });
  await host.create('session_a', owner);
  host.submitAsync('session_a', { version: '1.0', type: 'submit', request_id: 'prompt_a', content: 'hello' }, owner);
  output({ type: 'turn_result', session_id: 'session_a', turn_id: 'turn_a', outcome: 'denied' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.filter((event) => event.type === 'nnd.activity' && event.properties.kind === 'turn').at(-1).properties.status, 'failed');
});

function steer(request_id) { return { version: '1.0', type: 'steer', request_id, content: 'continue' }; }

function fakeEngine() {
  return {
    config: { executionManifest: null }, active: null,
    async initialize() {}, async steer(command) { return { accepted: true, request_id: command.request_id }; },
    async shutdown() {},
  };
}
