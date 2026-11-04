// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveManifest } from '../src/config.js';
import { routingModelOverlay, routingOverlay } from '../src/tui/routing-overlay.js';

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
const rows = [
  { connection_id: 'big', connection_name: 'Big box', endpoint: 'http://127.0.0.1:1/v1', model: 'glm', status: 'observed', context_limit_tokens: 131_072 },
  { connection_id: 'big', connection_name: 'Big box', endpoint: 'http://127.0.0.1:1/v1', model: 'glm-air', status: 'observed', context_limit_tokens: 32_768 },
  { connection_id: 'fast', connection_name: 'Fast box', endpoint: 'http://127.0.0.1:2/v1', model: 'qwen', status: 'observed', context_limit_tokens: 65_536 },
];

test('the first menu holds exactly the four jobs and no model rows', () => {
  const overlay = routingOverlay(engine(), { isMain: true, canManage: true });
  assert.deepEqual(overlay.items.map((item) => item.id), ['role:primary', 'role:reviewer', 'role:subagent', 'role:vision']);
  assert.equal(overlay.items.some((item) => item.id.startsWith('assign:')), false);
  assert.match(overlay.title, /which model does each job/iu);
});

test('each job states what it does and which model currently serves it', () => {
  const overlay = routingOverlay(engine(), { isMain: true, canManage: true });
  assert.match(role(overlay, 'primary').detail, /glm · Big box/u);
  assert.match(role(overlay, 'reviewer').detail, /qwen · Fast box/u);
  // Why: a job that follows Primary says so instead of naming a model of its own.
  assert.match(role(overlay, 'subagent').detail, /follows Primary · glm/u);
  assert.match(role(overlay, 'subagent').label, /runs delegated work/iu);
  assert.match(role(overlay, 'vision').label, /reads attached images/iu);
});

test('the model menu names the chosen job, offers every reachable model, and marks the one in use', () => {
  const overlay = routingModelOverlay(engine(), 'reviewer', { isMain: true, canManage: true, rows });
  assert.match(overlay.title, /^Reviewer model$/u);
  assert.match(overlay.lines.join('\n'), /Choose the model for reviewer, which checks tool requests/u);
  const modelIds = overlay.items.filter((item) => item.value).map((item) => item.id);
  assert.deepEqual(modelIds, ['big/glm', 'big/glm-air', 'fast/qwen']);
  const inUse = overlay.items.find((item) => item.id === 'fast/qwen');
  assert.match(inUse.badge, /in use/u);
  assert.match(overlay.items.find((item) => item.id === 'big/glm-air').badge, /32,768 ctx/u);
});

test('the model menu offers clearing a specialist back to Primary, but never for Primary', () => {
  const reviewer = routingModelOverlay(engine(), 'reviewer', { isMain: true, canManage: true, rows });
  assert.equal(reviewer.items[0].id, 'inherit');
  assert.match(reviewer.items[0].detail, /follows whatever model Primary uses/u);
  const primary = routingModelOverlay(engine(), 'primary', { isMain: true, canManage: true, rows });
  assert.equal(primary.items.some((item) => item.id === 'inherit'), false);
  // Why: only Primary can be typed in, because a specialist has no connection to name a model on.
  assert.equal(primary.items.some((item) => item.id === 'manual'), true);
});

test('an unassigned specialist offers no clear row', () => {
  const overlay = routingModelOverlay(engine({ primary: { provider_id: 'big' } }), 'subagent', { rows });
  assert.equal(overlay.items.some((item) => item.id === 'inherit'), false);
});

test('an empty sweep says so and offers no model to choose', () => {
  const overlay = routingModelOverlay(engine(), 'reviewer', { isMain: true, canManage: true, rows: [] });
  assert.deepEqual(overlay.items.map((item) => item.id), ['inherit', 'retry']);
  assert.match(overlay.items[1].detail, /open this list again/u);
});

test('a failed sweep keeps the failure visible instead of claiming nothing exists', () => {
  const overlay = routingModelOverlay(engine(), 'reviewer', { rows: [], discoveryError: 'provider_unavailable' });
  assert.match(overlay.lines.join('\n'), /Last check failed · provider_unavailable/u);
});

test('a vision model only claims image capability when the connection declares it', () => {
  const config = resolveManifest({
    connections: [{ id: 'art', endpoint: 'http://127.0.0.1:3/v1', trust_zone: 'loopback' }],
    model_selections: [
      { id: 'art-paint', connection_id: 'art', model: 'paint', capabilities: { images: true } },
      { id: 'art-text', connection_id: 'art', model: 'text', capabilities: { images: false } },
    ],
    routes: { primary: { selection_id: 'art-paint' } },
  });
  const overlay = routingModelOverlay({ config }, 'vision', {
    rows: [
      { connection_id: 'art-paint', connection_name: null, model: 'paint', status: 'observed' },
      { connection_id: 'art-paint', connection_name: null, model: 'unknown-paint', status: 'observed' },
    ],
  });
  // Why: the model in use is already known to work for its job, so its badge names that rather than
  // repeating a capability claim.
  assert.match(overlay.items.find((item) => item.id === 'art-paint/paint').badge, /in use/u);
  assert.doesNotMatch(overlay.items.find((item) => item.id === 'art-paint/unknown-paint').badge, /image capable/u);
});

test('a read-only conversation can open both menus but is told to manage from Main', () => {
  const roles = routingOverlay(engine(), { isMain: false, canManage: false });
  assert.match(roles.actionLabel, /view models/u);
  const models = routingModelOverlay(engine(), 'reviewer', { isMain: false, canManage: false, rows });
  assert.match(models.actionLabel, /manage from Main/u);
  assert.match(models.lines.join('\n'), /This conversation · Main settings are unchanged/u);
});
