// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { healthDetailOverlay, healthOverlay } from '../src/tui-health.js';

function fixtureHealth() {
  return {
    checked_at: '2026-08-07T22:05:26.934Z', read_only: true,
    installation: { status: 'ready', version: '20260807-2', runtime: 'v24.13.0', platform: 'win32', arch: 'x64' },
    configuration: { status: 'ready' }, runtime_bounds: { status: 'ready' },
    provider: { status: 'ready', endpoint: 'http://127.0.0.1:1234/v1', models: ['one', 'two', 'three'] },
    mcp: [
      { id: 'memory', state: 'ready', address: 'http://memory/mcp' },
      { id: 'inventory', state: 'failed', address: 'http://inventory/mcp', lastError: 'connection refused' },
    ],
  };
}

function fixtureSession() {
  return {
    id: 'session-1', name: 'Main', historyRecords: [], records: [
      { type: 'turn_result', turn_id: 'turn-good', outcome: 'completed', elapsed_ms: 1200, usage: { total_tokens: 420 } },
      { type: 'tool_status', tool: 'fs.read_text', target: 'missing.txt', status: 'failed', reason_code: 'not_found' },
      { type: 'turn_result', turn_id: 'turn-bad', outcome: 'failed', failure: { code: 'provider_timeout' } },
    ],
  };
}

test('health dashboard summarizes services and recent conversation without dumping model names', () => {
  const view = healthOverlay(fixtureHealth(), fixtureSession());
  assert.equal(view.kind, 'health');
  assert.equal(view.items.find((item) => item.id === 'provider').detail, 'http://127.0.0.1:1234/v1 | 3 models available');
  assert.equal(view.items.find((item) => item.id === 'mcp').detail, '1 up | 1 down | 2 configured');
  assert.equal(view.items.find((item) => item.id === 'turns').badge, '1/2 healthy');
  assert.match(view.items.find((item) => item.id === 'errors').badge, /found/u);
  assert.doesNotMatch(view.lines.join('\n'), /one|two|three/u);
});

test('health dashboard sections expand into bounded operator detail', () => {
  const health = fixtureHealth();
  const session = fixtureSession();
  const mcp = healthDetailOverlay('mcp', health, session);
  assert.equal(mcp.parent, 'health');
  assert.match(mcp.lines.join('\n'), /UP\s+memory/u);
  assert.match(mcp.lines.join('\n'), /DOWN inventory.*connection refused/u);

  const errors = healthDetailOverlay('errors', health, session);
  assert.match(errors.lines.join('\n'), /provider_timeout/u);
  assert.match(errors.lines.join('\n'), /fs\.read_text.*not_found/u);

  const runtime = healthDetailOverlay('runtime', health, session);
  assert.match(runtime.lines.join('\n'), /20260807-2/u);
  assert.doesNotMatch(runtime.lines.join('\n'), /\none\n|\ntwo\n|\nthree\n/u);
});
