// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { NndActiveTools } from '../src/nnd-active-tools.js';

test('NND active tools require correlated running status and clear on terminal state', () => {
  const tools = new NndActiveTools();
  assert.deepEqual(tools.projection(), { count: 0, names: [] });
  assert.equal(tools.observe({ type: 'tool_status', tool_request_id: 'a', tool: 'shell_run',
    status: 'running', arguments: { secret: 'private' } }), true);
  assert.deepEqual(tools.projection(), { count: 1, names: ['shell_run'] });
  assert.equal(tools.observe({ type: 'tool_status', tool_request_id: 'a', tool: 'shell_run', status: 'running' }), false);
  assert.equal(tools.observe({ type: 'tool_status', tool_request_id: 'a', tool: 'shell_run', status: 'succeeded' }), true);
  assert.deepEqual(tools.projection(), { count: 0, names: [] });
});

test('NND active tools marks ID-less running status unknown rather than falsely empty', () => {
  const tools = new NndActiveTools();
  assert.equal(tools.observe({ type: 'tool_status', tool: 'shell_run', status: 'running' }), true);
  assert.equal(tools.projection(), null);
});

test('NND active tools fail closed when completion cannot be correlated', () => {
  const tools = new NndActiveTools();
  tools.observe({ type: 'tool_status', provider_call_id: 'a', tool: 'shell_run', status: 'running' });
  assert.equal(tools.observe({ type: 'tool_status', tool: 'shell_run', status: 'failed' }), true);
  assert.equal(tools.projection(), null);
  assert.equal(tools.observe({ type: 'tool_status', provider_call_id: 'b', tool: 'edit', status: 'running' }), false);
  assert.equal(tools.projection(), null);
});
