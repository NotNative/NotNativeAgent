// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveManifest } from '../src/config.js';
import { handleRoutingCommand } from '../src/tui/routing-overlay.js';

function workspace() {
  const config = resolveManifest({
    providers: [
      { id: 'big', display_name: 'Big box', endpoint: 'http://127.0.0.1:1/v1', model: 'glm', trust_zone: 'loopback' },
    ],
    routes: { primary: { provider_id: 'big' } },
  });
  const calls = [], state = { overlay: null, notice: null };
  return {
    calls, state, config,
    activeConfig: () => config,
    projection: {
      active: () => ({ role: 'primary' }),
      openOverlay(value) { state.overlay = value; },
      showNotice(kind, text) { state.notice = { kind, text }; },
    },
    async modelSweep() { return [{ connection_id: 'big', connection_name: 'Big box', model: 'glm', status: 'observed' }]; },
    async selectRoute(...args) { calls.push(['route', ...args]); },
    async selectProviderForRole(...args) { calls.push(['role', ...args]); },
    async clearProviderForRole(...args) { calls.push(['clear', ...args]); },
  };
}

test('/routing with no argument opens the job menu', async () => {
  const w = workspace();
  await handleRoutingCommand('', w, (overlay) => { w.state.overlay = overlay; });
  assert.equal(w.state.overlay.kind, 'routing');
  assert.equal(w.state.overlay.items.length, 4);
});

test('/routing ROLE opens that role model list directly', async () => {
  const w = workspace();
  await handleRoutingCommand('reviewer', w, (overlay) => { w.state.overlay = overlay; });
  assert.equal(w.state.overlay.kind, 'routing-model');
  assert.equal(w.state.overlay.role, 'reviewer');
});

test('/routing primary MODEL sets the model without opening a menu', async () => {
  const w = workspace();
  await handleRoutingCommand('primary glm-air', w, (overlay) => { w.state.overlay = overlay; });
  assert.deepEqual(w.calls, [['route', 'big', 'glm-air']]);
  assert.match(w.state.notice.text, /Primary now uses glm-air/u);
});

test('/routing ROLE primary clears the role back to Primary', async () => {
  const w = workspace();
  await handleRoutingCommand('vision primary', w, () => undefined);
  assert.deepEqual(w.calls, [['clear', 'vision']]);
});

test('an unknown role or an over-long model name is refused with guidance', async () => {
  const w = workspace();
  await assert.rejects(handleRoutingCommand('narrator glm', w, () => undefined), /use \/routing/u);
  await assert.rejects(handleRoutingCommand(`primary ${'x'.repeat(257)}`, w, () => undefined), /256 characters/u);
});
