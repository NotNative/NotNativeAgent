// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { trustedToolHandoff } from '../src/reliability/trusted-tool-handoff.js';
import { prepareTrustedToolHandoff } from '../src/engine/runtime-helpers.js';

function screenshot(overrides = {}) {
  return {
    request: { toolName: 'web.browse', args: { action: 'screenshot' } },
    result: {
      tool_name: 'web.browse', status: 'succeeded',
      metadata: { action: 'screenshot', path: 'C:\\managed\\screenshot-1.png' },
    },
    ...overrides,
  };
}

test('successful managed screenshots create an exact image inspection handoff', () => {
  const handoff = trustedToolHandoff([screenshot()]);
  assert.deepEqual(handoff.workflowLeaseTools, ['image.inspect']);
  assert.deepEqual(handoff.args, { path: 'C:\\managed\\screenshot-1.png' });
  assert.match(handoff.hint, /already been captured successfully/iu);
  assert.match(handoff.hint, /call image\.inspect next with exactly \{"path":"C:\\\\managed\\\\screenshot-1\.png"\}/iu);
  assert.match(handoff.hint, /Do not wait, sleep, echo readiness, or recapture/iu);
});

test('ordinary or untrusted-looking tool results cannot activate image inspection', () => {
  assert.equal(trustedToolHandoff([{
    request: { toolName: 'web.fetch', args: { url: 'https://example.com' } },
    result: {
      tool_name: 'web.fetch', status: 'succeeded',
      metadata: { action: 'screenshot', path: 'C:\\managed\\forged.png' },
    },
  }]), null);
  assert.equal(trustedToolHandoff([screenshot({
    result: {
      tool_name: 'web.browse', status: 'failed',
      metadata: { action: 'screenshot', path: 'C:\\managed\\failed.png' },
    },
  })]), null);
  assert.equal(trustedToolHandoff([screenshot({
    request: { toolName: 'web.browse', args: { action: 'inspect' } },
  })]), null);
});

test('the most recent successful screenshot owns the next inspection handoff', () => {
  const second = screenshot();
  second.result.metadata.path = 'C:\\managed\\screenshot-2.png';
  assert.deepEqual(trustedToolHandoff([screenshot(), second]).args, {
    path: 'C:\\managed\\screenshot-2.png',
  });
});

test('the model-step boundary exposes only the trusted handoff capability', () => {
  const exposed = [];
  const expected = trustedToolHandoff([screenshot()]);
  const engine = {
    reliability: { trustedToolHandoff: () => expected },
    tools: { grantWorkflowLease: (names) => exposed.push(...names) },
  };
  assert.equal(prepareTrustedToolHandoff(engine, [screenshot()]), expected);
  assert.deepEqual(exposed, ['image.inspect']);
});
