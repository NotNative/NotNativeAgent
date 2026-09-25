import test from 'node:test';
import assert from 'node:assert/strict';
import { NndSessionRegistry } from '../src/nnd-session-registry.js';

test('NND registry grants only the owning principal while a child is active', async () => {
  const registry = new NndSessionRegistry();
  const engine = {
    active: { finalized: false },
    config: { executionManifest: null },
    steer: async (command) => ({ accepted: true, request_id: command.request_id }),
  };
  const stop = registry.register('child_1', 'parent_1', { subjectId: 'u1', workspaceIds: ['w1'] }, engine);
  assert.equal((await registry.resolve('child_1', { subjectId: 'u2', workspaceIds: ['w1'] })), null);
  const grant = await registry.resolve('child_1', { subjectId: 'u1', workspaceIds: ['w1'] });
  assert.equal(grant.steerSubagent, true);
  assert.deepEqual(await grant.steer({ request_id: 'r1', content: 'stop' }, { subjectId: 'u1' }), { accepted: true, request_id: 'r1' });
  await assert.rejects(() => grant.steer({ request_id: 'r2' }, { subjectId: 'u1' }), { code: 'invalid_content' });
  stop();
  assert.equal(await registry.resolve('child_1', { subjectId: 'u1', workspaceIds: ['w1'] }), null);
});
