// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { subagentDefinition } from '../src/subagent-tool.js';
import { subagentConfig } from '../src/subagent-runtime.js';

test('agent.run validates a bounded specialist request and returns its terminal result', async () => {
  let received;
  const definition = subagentDefinition({
    workspaceRoot: 'D:\\workspace',
    run: async (input) => {
      received = input;
      return { session_id: 'agent_planner_12345678', outcome: 'completed', text: 'planned', usage: { input_tokens: 10 } };
    },
  });
  const normalized = await definition.validate({ type: 'planner', task: 'Inspect and plan.' });
  const result = await definition.executor(normalized, new AbortController().signal);
  assert.deepEqual(received, { type: 'planner', task: 'Inspect and plan.' });
  assert.match(result.content, /"outcome": "completed"/u);
  await assert.rejects(() => definition.validate({ type: 'manager', task: 'Work' }), { code: 'subagent_request_invalid' });
});

test('subagent configuration promotes only the configured subagent route to primary', () => {
  const primary = { role: 'primary', providerId: 'slow', model: 'large' };
  const subagent = { role: 'subagent', providerId: 'fast', model: 'small' };
  const config = { routes: { primary, subagent }, applicationPolicy: 'Base policy.' };
  const derived = subagentConfig(config, 'coder');
  assert.equal(derived.routes.primary.providerId, 'fast');
  assert.equal(derived.routes.primary.model, 'small');
  assert.equal(derived.routes.subagent, subagent);
  assert.match(derived.applicationPolicy, /implementation stage/u);
  assert.equal(config.routes.primary, primary);
});
