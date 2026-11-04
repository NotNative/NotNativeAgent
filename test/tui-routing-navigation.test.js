// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveManifest } from '../src/config.js';
import { handleRoutingAction, routingModelOverlay, routingOverlay } from '../src/tui/routing-overlay.js';

function workspace(routes = { primary: { provider_id: 'big' }, reviewer: { provider_id: 'fast' } }) {
  const config = resolveManifest({
    providers: [
      { id: 'big', display_name: 'Big box', endpoint: 'http://127.0.0.1:1/v1', model: 'glm', trust_zone: 'loopback' },
      { id: 'fast', display_name: 'Fast box', endpoint: 'http://127.0.0.1:2/v1', model: 'qwen', trust_zone: 'loopback' },
    ],
    routes,
  });
  const calls = [];
  const state = { overlay: null, notice: null, sweeps: 0 };
  const projection = {
    active: () => ({ role: 'primary' }),
    get overlay() { return state.overlay; },
    openOverlay(value) { state.overlay = Object.freeze({ ...value }); },
    closeOverlay() { state.overlay = null; },
    moveOverlaySelection(delta) {
      const length = state.overlay.items.length;
      state.overlay = Object.freeze({ ...state.overlay, selected: (state.overlay.selected + delta + length) % length });
    },
    showNotice(kind, text) { state.notice = { kind, text }; },
  };
  const engine = { config, pendingConfig: config };
  return {
    state, calls, projection, config, engine,
    activeConfig: () => config,
    activeEngine: () => engine,
    async modelSweep() {
      state.sweeps += 1;
      return [
        { connection_id: 'big', connection_name: 'Big box', model: 'glm', status: 'observed' },
        { connection_id: 'big', connection_name: 'Big box', model: 'glm-air', status: 'observed' },
        { connection_id: 'fast', connection_name: 'Fast box', model: 'qwen', status: 'observed' },
      ];
    },
    async selectRoute(providerId, model) { calls.push(['route', providerId, model]); },
    async selectProviderForRole(role, providerId) { calls.push(['role', role, providerId]); },
    async clearProviderForRole(role) { calls.push(['clear', role]); },
  };
}

test('Enter on a job opens that job model list without closing routing', async () => {
  const w = workspace();
  w.state.overlay = routingOverlay({ config: w.config }, { isMain: true, canManage: true });
  const reviewerIndex = w.state.overlay.items.findIndex((item) => item.id === 'role:reviewer');
  w.state.overlay = Object.freeze({ ...w.state.overlay, selected: reviewerIndex });
  assert.equal(await handleRoutingAction({ action: 'submit' }, w), true);
  assert.equal(w.state.overlay.kind, 'routing-model');
  assert.equal(w.state.overlay.role, 'reviewer');
  assert.equal(w.state.sweeps, 1);
  assert.equal(w.calls.length, 0, 'opening the list changes nothing by itself');
});

test('Enter on a model saves it for that job and closes routing', async () => {
  const w = workspace();
  w.state.overlay = routingOverlay({ config: w.config }, { isMain: true, canManage: true });
  w.state.overlay = Object.freeze({ ...w.state.overlay, selected: 1 });
  await handleRoutingAction({ action: 'submit' }, w);
  const airIndex = w.state.overlay.items.findIndex((item) => item.id === 'big/glm-air');
  w.state.overlay = Object.freeze({ ...w.state.overlay, selected: airIndex });
  await handleRoutingAction({ action: 'submit' }, w);
  assert.deepEqual(w.calls, [['role', 'reviewer', 'big']]);
  assert.equal(w.state.overlay, null);
  assert.match(w.state.notice.text, /Reviewer now uses glm-air/u);
});

test('a Primary pick saves the model on the chosen connection', async () => {
  const w = workspace();
  w.state.overlay = routingOverlay({ config: w.config }, { isMain: true, canManage: true });
  await handleRoutingAction({ action: 'submit' }, w);
  const index = w.state.overlay.items.findIndex((item) => item.id === 'fast/qwen');
  w.state.overlay = Object.freeze({ ...w.state.overlay, selected: index });
  await handleRoutingAction({ action: 'submit' }, w);
  assert.deepEqual(w.calls, [['route', 'fast', 'qwen']]);
  assert.match(w.state.notice.text, /Main workspace default/u);
});

test('Escape steps back from the model list to the same job, then out', async () => {
  const w = workspace();
  w.state.overlay = routingOverlay({ config: w.config }, { isMain: true, canManage: true });
  w.state.overlay = Object.freeze({ ...w.state.overlay, selected: 2 });
  await handleRoutingAction({ action: 'submit' }, w);
  assert.equal(w.state.overlay.kind, 'routing-model');
  await handleRoutingAction({ action: 'back' }, w);
  assert.equal(w.state.overlay.kind, 'routing');
  assert.equal(w.state.overlay.items[w.state.overlay.selected].id, 'role:subagent');
  // Why: Escape at the first menu is not consumed, so the console falls through to its own behaviour.
  assert.equal(await handleRoutingAction({ action: 'back' }, w), false);
});

test('Ctrl+G closes routing from the model list', async () => {
  const w = workspace();
  w.state.overlay = routingOverlay({ config: w.config }, { isMain: true, canManage: true });
  await handleRoutingAction({ action: 'submit' }, w);
  await handleRoutingAction({ action: 'cancel' }, w);
  assert.equal(w.state.overlay, null);
});

test('clearing a specialist returns it to Primary rather than closing', async () => {
  const w = workspace();
  w.state.overlay = routingOverlay({ config: w.config }, { isMain: true, canManage: true });
  w.state.overlay = Object.freeze({ ...w.state.overlay, selected: 1 });
  await handleRoutingAction({ action: 'submit' }, w);
  assert.equal(w.state.overlay.items[0].id, 'inherit');
  await handleRoutingAction({ action: 'submit' }, w);
  assert.deepEqual(w.calls, [['clear', 'reviewer']]);
  assert.match(w.state.notice.text, /follows the Primary model/u);
});

test('a conversation without management rights is refused a write', async () => {
  const w = workspace();
  w.state.overlay = routingModelOverlayFor(w, 'reviewer', false);
  await handleRoutingAction({ action: 'submit' }, w);
  assert.equal(w.calls.length, 0);
  assert.match(w.state.notice.text, /Main conversation/u);
});

test('typing a model name saves it and keeps the list on a failed save', async () => {
  const w = workspace();
  w.state.overlay = routingModelOverlayFor(w, 'reviewer', true);
  const manualIndex = w.state.overlay.items.findIndex((item) => item.id === 'manual');
  assert.equal(manualIndex, -1, 'only Primary can type a model name');
  w.state.overlay = routingOverlay({ config: w.config }, { isMain: true, canManage: true });
  await handleRoutingAction({ action: 'submit' }, w);
  const primaryManual = w.state.overlay.items.find((item) => item.id === 'manual');
  w.state.overlay = Object.freeze({ ...w.state.overlay, selected: w.state.overlay.items.indexOf(primaryManual) });
  await handleRoutingAction({ action: 'submit' }, w);
  assert.equal(w.state.overlay.kind, 'routing-model-manual');
  assert.equal(w.state.overlay.editor.text, '');
  w.state.overlay.editor.set('local-model');
  await handleRoutingAction({ action: 'submit' }, w);
  assert.deepEqual(w.calls, [['route', 'big', 'local-model']]);
});

test('an empty model name is rejected with a reason instead of saving', async () => {
  const w = workspace();
  w.state.overlay = routingOverlay({ config: w.config }, { isMain: true, canManage: true });
  await handleRoutingAction({ action: 'submit' }, w);
  const primaryManual = w.state.overlay.items.find((item) => item.id === 'manual');
  w.state.overlay = Object.freeze({ ...w.state.overlay, selected: w.state.overlay.items.indexOf(primaryManual) });
  await handleRoutingAction({ action: 'submit' }, w);
  await handleRoutingAction({ action: 'submit' }, w);
  assert.equal(w.calls.length, 0);
  assert.match(w.state.overlay.lines.join('\n'), /Cannot continue · Enter the model name/u);
});

test('a failed save names the failure and leaves the list open', async () => {
  const w = workspace();
  w.selectRoute = async () => { throw Object.assign(new Error('endpoint refused'), { code: 'provider_unreachable' }); };
  w.state.overlay = routingOverlay({ config: w.config }, { isMain: true, canManage: true });
  await handleRoutingAction({ action: 'submit' }, w);
  const index = w.state.overlay.items.findIndex((item) => item.id === 'fast/qwen');
  w.state.overlay = Object.freeze({ ...w.state.overlay, selected: index });
  await handleRoutingAction({ action: 'submit' }, w);
  assert.equal(w.state.overlay.kind, 'routing-model');
  assert.match(w.state.notice.text, /Cannot save · endpoint refused/u);
});

function routingModelOverlayFor(w, role, canManage) {
  // Reuses the exported surface so the read-only path is exercised exactly as the console builds it.
  return routingModelOverlay({ config: w.config }, role, { canManage, isMain: canManage, rows: [
    { connection_id: 'big', connection_name: 'Big box', model: 'glm', status: 'observed' },
    { connection_id: 'fast', connection_name: 'Fast box', model: 'qwen', status: 'observed' },
  ] });
}
