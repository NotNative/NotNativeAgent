// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BrowserSessionManager, webBrowseDefinition } from '../src/web-browse-tool.js';
import { MandatoryReviewer } from '../src/reviewer.js';
import { PathPolicy } from '../src/path-policy.js';

test('web.browse advertises itself as the failed-fetch recovery path', () => {
  const definition = webBrowseDefinition({ manager: { close() {} } });
  assert.match(definition.purpose, /required fallback[^]*web\.fetch[^]*navigate to the same URL/iu);
  assert.match(definition.purpose, /screenshot capture returns[^]*image\.inspect[^]*separate tool call/iu);
  assert.match(definition.purpose, /workspace web app[^]*path[^]*temporary loopback server/iu);
});

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
  return { playwright: { chromium: { launch: async () => {
    state.launches = (state.launches ?? 0) + 1;
    return { newContext: async () => context, close: async () => { state.browserClosed = true; } };
  } } } };
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

test('concurrent browser operations share one initialization', async () => {
  const { state, manager } = await fixture();
  await Promise.all([
    manager.execute({ action: 'inspect' }, new AbortController().signal),
    manager.execute({ action: 'inspect' }, new AbortController().signal),
  ]);
  assert.equal(state.launches, 1);
  await manager.close();
});

test('browser screenshots return the managed image before any visual inference', async () => {
  const { state, manager } = await fixture();
  const captured = await manager.execute({ action: 'screenshot' }, new AbortController().signal);
  assert.equal(captured.metadata.path, state.screenshot);
  assert.match(captured.content, /Screenshot saved:[^]*image\.inspect[^]*exact path/iu);
  await manager.close();
});

test('web.browse identifies the action-specific argument that needs repair', async () => {
  const { manager, definition } = await fixture();
  await assert.rejects(definition.validate({ action: 'click' }), {
    code: 'tool_schema_invalid', message: 'browser action "click" requires argument "target"',
  });
  await assert.rejects(definition.validate({ action: 'navigate' }), {
    code: 'tool_schema_invalid', message: /exactly one/u,
  });
  await manager.close();
});

test('web.browse serves a workspace entry with an owned temporary server and no project dependency', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'nna-browser-workspace-'));
  await writeFile(join(workspace, 'index.html'), '<!doctype html><title>Ocean</title><script src="/main.js"></script>');
  await writeFile(join(workspace, 'main.js'), 'document.body.dataset.ready = "true";');
  const paths = new PathPolicy(workspace, { boundedToWorkspace: true });
  await paths.initialize();
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'nna-browser-runtime-'));
  const state = {};
  const manager = new BrowserSessionManager({
    root: runtimeRoot, managedPlaywrightRoot: runtimeRoot, paths,
    loadPlaywright: async () => fakeRuntime(state),
    policy: { classify: async () => 'public_network' }, resolveHost: async () => ['127.0.0.1'],
  });
  const definition = webBrowseDefinition({ manager });
  const request = await definition.validate({ action: 'navigate', path: 'index.html' });
  assert.equal(request.resolved.destination, 'managed_workspace_origin');
  const result = await definition.executor(request, new AbortController().signal);
  assert.equal(result.metadata.destination, 'managed_workspace_origin');
  assert.match(state.url, /^http:\/\/127\.0\.0\.1:\d+\/index\.html$/u);
  const response = await fetch(new URL('/main.js', state.url));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /dataset\.ready/u);
  await manager.close();
  await assert.rejects(fetch(state.url));
});

test('standalone browser admits exact loopback navigation for review without trusting private LAN hosts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-browser-loopback-'));
  const state = {};
  const manager = new BrowserSessionManager({
    root, managedPlaywrightRoot: root, loadPlaywright: async () => fakeRuntime(state),
    resolveHost: async (host) => host === 'localhost' ? ['127.0.0.1'] : ['192.168.1.20'],
  });
  const definition = webBrowseDefinition({ manager });
  const request = await definition.validate({ action: 'navigate', url: 'http://localhost:8123/#scene' });
  assert.equal(request.args.url, 'http://localhost:8123/');
  assert.equal(request.resolved.destination, 'reviewable_loopback_origin');
  const ipv6 = await definition.validate({ action: 'navigate', url: 'http://[::1]:8123/' });
  assert.equal(ipv6.resolved.destination, 'reviewable_loopback_origin');
  await assert.rejects(definition.validate({ action: 'navigate', url: 'http://192.168.1.20:8123/' }), {
    code: 'web_fetch_destination_blocked',
  });
  await manager.close();
});

test('approved loopback navigation admits only its active exact origin inside the browser session', async () => {
  const { state, manager, definition } = await fixture({
    policy: { classify: async (url) => {
      if (url.hostname === 'localhost') {
        const error = new Error('blocked'); error.code = 'web_fetch_destination_blocked'; throw error;
      }
      return 'public_network';
    } },
    resolveHost: async (host) => host === 'localhost' ? ['127.0.0.1'] : ['93.184.216.34'],
  });
  const request = await definition.validate({ action: 'navigate', url: 'http://localhost:8123/' });
  await definition.executor(request, new AbortController().signal, { reviewerDecisionId: 'decision_1' });
  assert.equal((await manager.classifyRouteUrl('http://localhost:8123/main.js')).destination, 'reviewable_loopback_origin');
  await assert.rejects(manager.classifyRouteUrl('http://localhost:9000/admin'), { code: 'web_fetch_destination_blocked' });
  assert.equal(typeof state.route, 'function');
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
  const workspace = await reviewer.review({
    ...base, id: 'tool_workspace', args: { action: 'navigate', path: 'index.html' },
    resolved: { action: 'navigate', readOnly: true, destination: 'managed_workspace_origin', path: 'D:/workspace/index.html' },
  }, context);
  assert.equal(workspace.reasonCode, 'deterministic_safe');
  const clicked = await reviewer.review({ ...base, id: 'tool_2', args: { action: 'click', target: 'e1' }, resolved: { action: 'click', readOnly: false, destination: null } }, context);
  assert.equal(clicked.reasonCode, 'semantic_intent_match');
  assert.equal(semanticCalls, 1);
});

test('loopback browser navigation requires semantic review', async () => {
  const { definition } = await fixture();
  const ledger = {
    async propose() { return { repetition: 0 }; }, summary() { return []; },
    async commitDecision(_id, decision) { return decision; },
  };
  let semanticCalls = 0;
  const reviewer = new MandatoryReviewer({ ledger, semanticReviewer: { async review() {
    semanticCalls += 1; return { outcome: 'approve', confidence: 1, reason_code: 'intent_match' };
  } } });
  const request = {
    id: 'tool_loopback', toolName: 'web.browse', args: { action: 'navigate', url: 'http://localhost:8123/' },
    resolved: { action: 'navigate', readOnly: true, destination: 'reviewable_loopback_origin', origin: 'http://localhost:8123' },
    authorityId: 'a', authorityVersion: 1, policyVersion: 1, expiresAt: Date.now() + 1000,
  };
  const context = {
    definition, authority: { intent: [{ content: 'Build and visually verify the local Three.js scene in a browser' }] },
    surface: 'interactive_tui', signal: new AbortController().signal,
  };
  const decision = await reviewer.review(request, context);
  assert.equal(decision.reasonCode, 'semantic_intent_match');
  assert.equal(semanticCalls, 1);
});

test('hosted registries do not implicitly expose the standalone root browser', async () => {
  const { ToolRegistry } = await import('../src/tool-registry.js');
  const root = await mkdtemp(join(tmpdir(), 'nna-browser-hosted-'));
  const registry = new ToolRegistry(root, { hosted: true, boundedToWorkspace: true, allowedTools: ['web.browse'] });
  await registry.initialize();
  assert.equal(registry.snapshot().some((item) => item.name === 'web.browse'), false);
});
