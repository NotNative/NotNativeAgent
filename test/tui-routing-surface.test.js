// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveManifest } from '../src/config.js';
import { routingOverlay } from '../src/tui/routing-overlay.js';

function engine(routes = { primary: { provider_id: 'big' }, reviewer: { provider_id: 'fast' } }) {
  const config = resolveManifest({
    providers: [
      { id: 'big', display_name: 'Big box', endpoint: 'http://127.0.0.1:1/v1', model: 'glm', trust_zone: 'loopback' },
      { id: 'fast', display_name: 'Fast box', endpoint: 'http://127.0.0.1:2/v1', model: 'qwen', trust_zone: 'loopback' },
    ],
    routes,
  });
  return { config };
}

const role = (overlay, id) => overlay.items.find((item) => item.id === `role:${id}`);

test('every role reports its own selection or that it follows Primary', () => {
  const overlay = routingOverlay(engine(), { isMain: true, canManage: true });
  assert.match(role(overlay, 'primary').detail, /Big box · glm/u);
  assert.equal(role(overlay, 'primary').badge, 'primary');
  assert.match(role(overlay, 'reviewer').detail, /Fast box · qwen/u);
  assert.equal(role(overlay, 'reviewer').badge, 'assigned');
  // Why: an unassigned role resolves to the primary selection, and the row says so.
  assert.match(role(overlay, 'subagent').detail, /follows Primary \(glm\)/u);
  assert.equal(role(overlay, 'subagent').badge, 'inherit');
  assert.equal(role(overlay, 'vision').badge, 'inherit');
});

test('the surface offers assignment and clear only where the operator may write', () => {
  const writable = routingOverlay(engine(), { isMain: true, canManage: true });
  assert.equal(writable.items.some((item) => item.id === 'assign:reviewer:big'), true);
  assert.equal(writable.items.some((item) => item.id === 'clear:reviewer'), true);
  // Why: Primary is required, so it is never cleared and is not offered as a global assignment.
  assert.equal(writable.items.some((item) => item.id === 'clear:primary'), false);
  assert.equal(writable.items.some((item) => item.id === 'assign:primary:big'), false);
  const readOnly = routingOverlay(engine(), { isMain: false, canManage: false });
  assert.equal(readOnly.items.every((item) => item.id.startsWith('role:')), true);
  assert.match(readOnly.actionLabel, /manage from Main/u);
});

test('an unassigned role offers no clear action', () => {
  const overlay = routingOverlay(engine({ primary: { provider_id: 'big' } }), { isMain: true, canManage: true });
  assert.equal(overlay.items.some((item) => item.id === 'clear:reviewer'), false);
  assert.equal(role(overlay, 'reviewer').badge, 'inherit');
});
