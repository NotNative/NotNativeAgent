import test from 'node:test';
import assert from 'node:assert/strict';
import { NndSessionRegistry } from '../src/nnd-session-registry.js';

test('NND registry grants only the owning principal while a child is active', async () => {
  const registry = new NndSessionRegistry();
  const engine = {
    active: { finalized: false },
    config: { executionManifest: null, workspaceRoot: 'D:\\work' },
    transcript: [{ type: 'message', role: 'assistant', content: 'Live child answer' }],
    steer: async (command) => ({ accepted: true, request_id: command.request_id }),
  };
  const stop = registry.register('child_1', 'parent_1', { subjectId: 'u1', workspaceIds: ['w1'] }, engine);
  assert.equal((await registry.resolve('child_1', { subjectId: 'u2', workspaceIds: ['w1'] })), null);
  const grant = await registry.resolve('child_1', { subjectId: 'u1', workspaceIds: ['w1'] });
  assert.equal(grant.steerSubagent, true);
  assert.deepEqual(await grant.steer({ request_id: 'r1', content: 'stop' }, { subjectId: 'u1', workspaceIds: ['w1'] }), { accepted: true, request_id: 'r1' });
  await assert.rejects(() => grant.steer({ request_id: 'r2' }, { subjectId: 'u1', workspaceIds: ['w1'] }), { code: 'invalid_content' });
  assert.equal(registry.get('child_1', { subjectId: 'u1', workspaceIds: ['w1'] }).parentID, 'parent_1');
  assert.equal(registry.statuses({ subjectId: 'u1', workspaceIds: ['w1'] }).child_1.type, 'busy');
  stop();
  assert.equal((await registry.resolve('child_1', { subjectId: 'u1', workspaceIds: ['w1'] })).steerSubagent, false);
  await assert.rejects(() => grant.steer({ request_id: 'r3', content: 'again' }, { subjectId: 'u1', workspaceIds: ['w1'] }), { code: 'steering_unavailable' });
  assert.deepEqual(registry.messages('child_1', { subjectId: 'u1', workspaceIds: ['w1'] }).map(({ item }) => item.content), ['Live child answer']);
  assert.deepEqual(registry.statuses({ subjectId: 'u1', workspaceIds: ['w1'] }), {});
  registry.unregisterParent('parent_1');
  assert.equal(registry.get('child_1', { subjectId: 'u1', workspaceIds: ['w1'] }), null);
});

test('NND child transcript and steering require the complete original workspace grant', async () => {
  const registry = new NndSessionRegistry();
  const owner = { subjectId: 'u1', workspaceIds: ['w1', 'w2'] };
  const engine = { active: { finalized: false }, config: { workspaceRoot: 'D:\\work' }, transcript: [], steer: async () => ({ accepted: true }) };
  registry.register('child_1', 'parent_1', owner, engine);
  const partial = { subjectId: 'u1', workspaceIds: ['w2'] };
  assert.equal(registry.get('child_1', partial), null);
  assert.equal(registry.messages('child_1', partial), null);
  assert.deepEqual(registry.list(partial), []);
  assert.equal(await registry.resolve('child_1', partial), null);
  assert.deepEqual(registry.statuses(partial), {});
});

test('NND child transcript cache bounds text and evicts completed records before live children', () => {
  const registry = new NndSessionRegistry(1);
  const owner = { subjectId: 'u1', workspaceIds: ['w1'] };
  const first = { active: null, transcript: [{ type: 'message', role: 'assistant', content: 'x'.repeat(300_000) }] };
  const stop = registry.register('child_1', 'parent_1', owner, first);
  stop();
  const excerpt = registry.messages('child_1', owner);
  assert.equal(excerpt.length, 1);
  assert.ok(excerpt[0].item.content.startsWith('[Earlier text omitted'));
  assert.equal(excerpt[0].item.content.length, 262_144);
  registry.register('child_2', 'parent_1', owner, { active: null, transcript: [] });
  assert.equal(registry.get('child_1', owner), null);
  assert.equal(registry.get('child_2', owner).parentID, 'parent_1');
});

test('NND completed child time remains recoverable after a wall-clock correction', () => {
  const registry = new NndSessionRegistry();
  const owner = { subjectId: 'u1', workspaceIds: ['w1'] };
  const originalNow = Date.now;
  try {
    Date.now = () => 2_000;
    const stop = registry.register('child_1', 'parent_1', owner, { active: null, transcript: [] });
    Date.now = () => 1_000;
    stop();
    const snapshot = registry.completedSnapshot('child_1', 2_000);
    assert.equal(snapshot.createdAt, 2_000);
    assert.equal(snapshot.updatedAt, 2_001, 'settled child must outrank its earlier live description');
  } finally { Date.now = originalNow; }
});

test('NND child agent identity is a bounded structured field, not parsed from the title', () => {
  const owner = { subjectId: 'u1', workspaceIds: ['w1'] };
  const registry = new NndSessionRegistry();
  const engine = { active: null, transcript: [] };
  registry.register('child_coder', 'parent_1', owner, engine, { type: ' coder ' });
  assert.equal(registry.get('child_coder', owner).agent, 'coder');
  assert.equal(registry.get('child_coder', owner).title, 'Subagent · coder');
  registry.register('child_invalid', 'parent_1', owner, engine, { type: 'bad\nname' });
  assert.equal(registry.get('child_invalid', owner).agent, undefined);
  assert.equal(registry.get('child_invalid', owner).title, 'Subagent');
  registry.register('child_long', 'parent_1', owner, engine, { type: 'x'.repeat(129) });
  assert.equal(registry.get('child_long', owner).agent, undefined);
  assert.equal(registry.get('child_long', owner).title, 'Subagent');
});
