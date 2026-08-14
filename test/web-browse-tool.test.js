// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BrowserSessionManager, webBrowseDefinition } from '../src/web-browse-tool.js';
import { MandatoryReviewer } from '../src/reviewer.js';

function fakeRuntime(state) {
  const locator = (selector) => ({
    first: () => locator(selector), nth: (index) => locator(`${selector}:${index}`),
    click: async () => { state.clicked = selector; },
    fill: async (value) => { state.filled = { selector, value }; },
    press: async (key) => { state.pressed = { selector, key }; },
    innerText: async () => state.body ?? 'Example body',
    evaluateAll: async () => [{ index: 0, tag: 'button', type: null, role: null, text: 'Continue' }],
  });
  const page = {
    goto: async (url) => { state.url = url; }, url: () => state.url ?? 'about:blank',
    title: async () => 'Example', locator,
    screenshot: async ({ path }) => { state.screenshot = path; },
  };
  const context = {
    route: async (_pattern, handler) => { state.route = handler; }, newPage: async () => page,
    close: async () => { state.contextClosed = true; },
  };
  return { playwright: { chromium: { launch: async () => ({ newContext: async () => context, close: async () => { state.browserClosed = true; } }) } } };
}

async function fixture(extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nna-browser-'));
  const state = {};
  const manager = new BrowserSessionManager({
    root, managedPlaywrightRoot: root, loadPlaywright: async () => fakeRuntime(state),
    policy: { classify: async () => 'public_network' }, resolveHost: async () => ['93.184.216.34'],
    ...extra,
  });
  return { root, state, manager, definition: webBrowseDefinition({ manager }) };
}

test('web.browse validates destinations and exposes bounded element references', async () => {
  const { state, manager, definition } = await fixture();
  const request = await definition.validate({ action: 'navigate', url: 'https://example.com/#fragment' });
  assert.equal(request.args.url, 'https://example.com/');
  assert.equal(request.resolved.readOnly, true);
  const navigated = await definition.executor(request, new AbortController().signal, { reviewerDecisionId: 'decision_1' });
  assert.match(navigated.content, /Example body/u);
  const inspected = await manager.execute({ action: 'inspect' }, new AbortController().signal);
  assert.match(inspected.content, /\[e1\].*Continue/u);
  await manager.execute({ action: 'click', target: 'e1' }, new AbortController().signal);
  assert.match(state.clicked, /:0$/u);
  await manager.close();
  assert.equal(state.browserClosed, true);
});

test('web.browse identifies the action-specific argument that needs repair', async () => {
  const { manager, definition } = await fixture();
  await assert.rejects(definition.validate({ action: 'click' }), {
    code: 'tool_schema_invalid', message: 'browser action "click" requires argument "target"',
  });
  await manager.close();
});

test('web.browse injects a secret field only inside the trusted browser consumer', async () => {
  const calls = [];
  const secretBroker = { async withSecret(id, request, consumer) {
    calls.push({ id, request }); return consumer({ username: 'operator', password: 'not-for-model' });
  } };
  const { state, manager } = await fixture({ secretBroker, sessionId: 'session_1' });
  await manager.execute({ action: 'navigate', url: 'https://example.com/' }, new AbortController().signal);
  state.body = 'Account authenticated with not-for-model';
  const output = await manager.execute({ action: 'fill_secret', target: '#password', secret_id: 'sec_1', secret_field: 'password' }, new AbortController().signal, { reviewerDecisionId: 'decision_1' });
  assert.equal(state.filled.value, 'not-for-model');
  assert.equal(calls[0].request.destination, 'https://example.com');
  assert.equal(JSON.stringify(calls).includes('not-for-model'), false);
  assert.equal(output.content.includes('not-for-model'), false);
});

test('browser observation is deterministic-safe while interaction requires semantic review', async () => {
  const { definition } = await fixture();
  const ledger = {
    async propose() { return { repetition: 0 }; }, summary() { return []; },
    async commitDecision(_id, decision) { return decision; },
  };
  let semanticCalls = 0;
  const reviewer = new MandatoryReviewer({ ledger, semanticReviewer: { async review() {
    semanticCalls += 1; return { outcome: 'approve', confidence: 1, reason_code: 'intent_match' };
  } } });
  const base = { id: 'tool_1', toolName: 'web.browse', args: { action: 'inspect' }, authorityId: 'a', authorityVersion: 1, policyVersion: 1, expiresAt: Date.now() + 1000 };
  const context = { definition, authority: { intent: [{ content: 'Browse example and click Continue' }] }, surface: 'interactive_tui', signal: new AbortController().signal };
  const observed = await reviewer.review({ ...base, resolved: { action: 'inspect', readOnly: true, destination: null } }, context);
  assert.equal(observed.reasonCode, 'deterministic_safe');
  const clicked = await reviewer.review({ ...base, id: 'tool_2', args: { action: 'click', target: 'e1' }, resolved: { action: 'click', readOnly: false, destination: null } }, context);
  assert.equal(clicked.reasonCode, 'semantic_intent_match');
  assert.equal(semanticCalls, 1);
});

test('hosted registries do not implicitly expose the standalone root browser', async () => {
  const { ToolRegistry } = await import('../src/tool-registry.js');
  const root = await mkdtemp(join(tmpdir(), 'nna-browser-hosted-'));
  const registry = new ToolRegistry(root, { hosted: true, boundedToWorkspace: true, allowedTools: ['web.browse'] });
  await registry.initialize();
  assert.equal(registry.snapshot().some((item) => item.name === 'web.browse'), false);
});
