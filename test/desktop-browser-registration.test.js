// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { createScratchSync } from './scratch.js';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createIntegrationDesktopEngineHost } from '../src/integration-cli.js';
import { createDesktopBrowserCallbackRegistry, dispatchDesktopBrowserRegistrationRequest } from '../src/desktop-browser-registration.js';
import { startIntegrationServer } from '../src/integration-server.js';
import { createDesktopLocalIntegrationActivation } from '../src/nno-integration-activation.js';
import { nativeDesktopPrincipal } from '../src/desktop-service-native.js';

const URL_A = 'http://127.0.0.1:4172/api/browser-control/request';
const URL_B = 'http://127.0.0.1:4173/api/browser-control/request';
const TOKEN_A = 'a'.repeat(43);
const TOKEN_B = 'b'.repeat(43);

function registrationBody(url, token) { return { url, token }; }

test('the browser callback registry validates, replaces, and clears the callback', () => {
  const registry = createDesktopBrowserCallbackRegistry();
  assert.equal(registry.current(), null);
  assert.throws(() => registry.set(registrationBody('http://evil.example:4172/api/browser-control/request', TOKEN_A)));
  assert.throws(() => registry.set(registrationBody(URL_A, 'short')));
  assert.throws(() => registry.set(registrationBody(URL_A)));
  assert.throws(() => registry.set({ ...registrationBody(URL_A, TOKEN_A), extra: true }));
  assert.equal(registry.current(), null);
  const first = registry.set(registrationBody(URL_A, TOKEN_A));
  assert.deepEqual(first, { url: URL_A, token: TOKEN_A });
  assert.deepEqual(registry.current(), first);
  const second = registry.set(registrationBody(URL_B, TOKEN_B));
  assert.deepEqual(registry.current(), second);
  registry.clear();
  assert.equal(registry.current(), null);
  // Re-registration after a clear works (desktop UI restart).
  assert.deepEqual(registry.set(registrationBody(URL_A, TOKEN_A)), { url: URL_A, token: TOKEN_A });
});

test('the registration route refuses unauthenticated, unauthorized, and invalid calls', async () => {
  const registry = createDesktopBrowserCallbackRegistry();
  const serviceToken = randomBytes(32).toString('base64url');
  const service = await startIntegrationServer({
    activation: createDesktopLocalIntegrationActivation(), token: serviceToken,
    instanceId: 'test-instance', desktopBrowserCallbackRegistry: registry, host: '127.0.0.1', port: 0,
  });
  const endpoint = `http://127.0.0.1:${service.address.port}`;
  const route = `${endpoint}/internal/desktop/browser-callback`;
  const principal = (permissions) => Buffer.from(JSON.stringify({
    subject_id: 'operator', platform_role: 'operator', permissions, workspace_ids: [], group_ids: [],
    trace_id: 'registration-test', issued_at: new Date().toISOString(), request_id: 'registration-test',
  })).toString('base64url');
  const allowed = principal(['desktop.browser.manage']);
  const denied = principal(['desktop.read']);
  const call = async (method, header, body) => fetch(route, {
    method, headers: { ...(header ? { authorization: `Bearer ${serviceToken}`, 'x-nna-principal': header } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    let response = await call('POST', null, registrationBody(URL_A, TOKEN_A));
    assert.equal(response.status, 401);
    response = await call('POST', allowed, registrationBody('http://evil.example:4172/api/browser-control/request', TOKEN_A));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'tool_schema_invalid');
    response = await call('POST', denied, registrationBody(URL_A, TOKEN_A));
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'integration_permission_denied');
    response = await call('PATCH', allowed, registrationBody(URL_A, TOKEN_A));
    assert.equal(response.status, 405);
    assert.equal(registry.current(), null);

    response = await call('GET', allowed);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { registered: false });

    response = await call('POST', allowed, registrationBody(URL_A, TOKEN_A));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { registered: true, url: URL_A });
    assert.deepEqual(registry.current(), { url: URL_A, token: TOKEN_A });

    response = await call('POST', allowed, registrationBody(URL_B, TOKEN_B));
    assert.equal(response.status, 200);
    assert.deepEqual(registry.current(), { url: URL_B, token: TOKEN_B });
    response = await call('GET', allowed);
    assert.deepEqual(await response.json(), { registered: true, url: URL_B });

    response = await call('DELETE', allowed);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { registered: false });
    assert.equal(registry.current(), null);
    response = await call('GET', allowed);
    assert.deepEqual(await response.json(), { registered: false });
  } finally { await service.close(); }
});

test('engines created after runtime registration install the desktop_browser tool', async () => {
  const root = createScratchSync('nna-browser-registration-');
  const configRoot = join(root, 'config');
  await mkdir(configRoot, { recursive: true });
  await writeFile(join(configRoot, 'manifest.json'), JSON.stringify({
    format_version: 1, persistence: 'ephemeral', workspace_root: root,
    providers: [{ id: 'primary', display_name: 'Primary', endpoint: 'http://127.0.0.1:1234/v1', model: 'test', trust_zone: 'loopback' }],
    routes: { primary: { provider_id: 'primary', model: 'test' } },
  }));
  const registry = createDesktopBrowserCallbackRegistry();
  const host = await createIntegrationDesktopEngineHost({
    root, config: configRoot, sessions: join(root, 'sessions'), reviewerLedger: join(root, 'reviewer'), hooks: join(root, 'hooks'),
  }, { desktopBrowserCallbackRegistry: registry });
  const principal = { subjectId: 'operator', workspaceIds: nativeDesktopPrincipal(root).workspaceIds };
  try {
    const before = await host.create('session_before', principal);
    assert.equal(before.engine.tools.definition('desktop_browser'), undefined);
    registry.set(registrationBody(URL_A, TOKEN_A));
    const after = await host.create('session_after', principal);
    assert.equal(after.engine.tools.definition('desktop_browser')?.scope, 'browser');
    assert.equal(after.engine.tools.definition('web_browse'), undefined);
    // The provider action surface must expose the installed browser tool directly.
    assert.ok(after.engine.tools.providerDefinitions("").some((item) => item.function.name === 'desktop_browser'));
    // Clearing removes the callback for later sessions only.
    registry.clear();
    const cleared = await host.create('session_cleared', principal);
    assert.equal(cleared.engine.tools.definition('desktop_browser'), undefined);
  } finally { await host.shutdown(); }
});

test('the registration dispatcher ignores unrelated routes and missing registries', async () => {
  const response = { statusCode: 0, end(value) { this.body = value; }, setHeader() {} };
  assert.equal(await dispatchDesktopBrowserRegistrationRequest(
    { method: 'POST', url: '/internal/desktop/browser-callback' }, response, { url: new URL('/internal/desktop/browser-callback', 'http://127.0.0.1') }), false);
  assert.equal(await dispatchDesktopBrowserRegistrationRequest(
    { method: 'POST' }, response, { url: new URL('/internal/desktop/browser-callback', 'http://127.0.0.1'), principal: { permissions: ['desktop.browser.manage'] } }), false);
});
