// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createNndHooksSettingsService, projectHooksList } from '../src/nnd-hooks-routes.js';
import { startIntegrationServer } from '../src/integration-server.js';
import { createNndLocalIntegrationActivation } from '../src/nno-integration-activation.js';

const identity = { installation_id: 'install_hooks', data_id: 'data_hooks' };
const token = 'hooks-http-test-token-36-chars-test';
const principal = { subjectId: 'operator@example.com', permissions: ['nnd.configuration.read'] };

const fixture = async () => {
  const root = await mkdtemp(join(homedir(), '.nna-hooks-settings-'));
  const hooksPath = join(root, 'hooks');
  const service = createNndHooksSettingsService({ hooksPath,
    installationId: identity.installation_id, dataId: identity.data_id });
  return { root, hooksPath, service };
};

const manifest = (directory, name, subscriptions, version) => writeFile(
  join(directory, 'manifest.json'), JSON.stringify({ name, version, subscriptions }));
const filler = async (hooksPath, index) => {
  const name = `w-fill-${String(index).padStart(2, '0')}`;
  const directory = join(hooksPath, name);
  await mkdir(directory, { recursive: true });
  await manifest(directory, name, [], '1');
};

test('absent store reads as absent and a live store projects discovery verbatim', async () => {
  const f = await fixture();
  try {
    const absent = projectHooksList(await f.service.list());
    assert.equal(absent.source_state, 'absent');
    assert.equal(absent.count, 0);
    assert.deepEqual(absent.hooks, []);
    assert.deepEqual(absent.diagnostics, []);
    assert.equal(absent.application, 'next_hook_use');
    assert.equal(absent.scope, 'user');
    assert.deepEqual(Object.keys(absent).sort(), ['application', 'count', 'data_id',
      'diagnostics', 'hooks', 'installation_id', 'schema_version', 'scope', 'source_state']);
    // A live store with one well-formed bundle, one broken bundle, and an
    // over-cap fill preserves the discovery honesty exactly.
    const first = { event: 'turn', phase: 'pre', command: 'cmd --flag', blocking: false,
      priority: 5, timeout_ms: 5000, max_concurrent: 2 };
    const second = { event: 'session.start', phase: 'post', command: 'quoted command with spaces' };
    const bundleDirectory = join(f.hooksPath, 'a-valid');
    await mkdir(bundleDirectory, { recursive: true });
    await manifest(bundleDirectory, 'a-valid', [first, second], '7'.repeat(120));
    const brokenDirectory = join(f.hooksPath, 'b-broken');
    await mkdir(brokenDirectory, { recursive: true });
    await writeFile(join(brokenDirectory, 'manifest.json'), '{not json');
    for (let index = 1; index <= 33; index += 1) await filler(f.hooksPath, index);
    const list = projectHooksList(await f.service.list());
    assert.equal(list.source_state, 'present');
    assert.equal(list.count, 31);
    const bundle = list.hooks[0];
    assert.deepEqual(Object.keys(bundle).sort(), ['directory_name', 'name', 'subscriptions', 'version']);
    assert.equal(bundle.name, 'a-valid');
    assert.equal(bundle.version, '7'.repeat(64));
    assert.equal(bundle.directory_name, 'a-valid');
    assert.ok(!JSON.stringify(list.hooks).includes(join(f.root, 'hooks')));
    assert.deepEqual(Object.keys(bundle.subscriptions[0]).sort(), ['blocking', 'command', 'event',
      'max_concurrent', 'phase', 'priority', 'timeout_ms']);
    assert.deepEqual(bundle.subscriptions[0], { event: 'turn', phase: 'pre', command: 'cmd --flag',
      blocking: false, priority: 5, timeout_ms: 5000, max_concurrent: 2 });
    assert.deepEqual(bundle.subscriptions[1], { event: 'session.start', phase: 'post',
      command: 'quoted command with spaces', blocking: true, priority: 100, timeout_ms: 10_000,
      max_concurrent: 1 });
    assert.equal(list.diagnostics.length, 2);
    const limit = list.diagnostics.find((entry) => entry.status === 'limit_reached');
    assert.deepEqual(limit, { bundle: null, status: 'limit_reached',
      code: 'hook_bundle_limit_reached', omitted: 3 });
    const skipped = list.diagnostics.find((entry) => entry.status === 'skipped');
    assert.deepEqual(skipped, { bundle: 'b-broken', status: 'skipped', code: 'invalid_hook_manifest' });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('projector refuses grammar and envelope drift', async () => {
  const f = await fixture();
  try {
    const raw = await f.service.list();
    const envelope = (hooks, diagnostics = raw.diagnostics, count = hooks.length, sourceState = 'present') =>
      ({ installationId: identity.installation_id, dataId: identity.data_id, sourceState,
        count, hooks, diagnostics });
    const bundle = { directoryName: 'a-valid', name: 'a-valid', version: '1.0.0', subscriptions: [{
      event: 'turn', phase: 'pre', command: 'cmd', blocking: true, priority: 0,
      timeoutMs: 10_000, maxConcurrent: 1 }] };
    const driftRefusal = { code: 'nnd_hooks_projection_invalid' };
    assert.throws(() => projectHooksList({ ...envelope([bundle]), extra: 1 }), driftRefusal);
    assert.throws(() => projectHooksList(envelope([bundle], raw.diagnostics, 2)), driftRefusal);
    assert.throws(() => projectHooksList(envelope([bundle], raw.diagnostics, 1, 'absent')), driftRefusal);
    assert.throws(() => projectHooksList(envelope([{ ...bundle, extra: 1 }])), driftRefusal);
    assert.throws(() => projectHooksList(envelope([{ ...bundle, name: '../escape' }])), driftRefusal);
    assert.throws(() => projectHooksList(envelope([{ ...bundle, version: 'x'.repeat(65) }])), driftRefusal);
    assert.throws(() => projectHooksList(envelope([{ ...bundle, subscriptions: [{ ...bundle.subscriptions[0], timeoutMs: 99 }] }])), driftRefusal);
    assert.throws(() => projectHooksList(envelope([{ ...bundle, subscriptions: [{ ...bundle.subscriptions[0], maxConcurrent: 17 }] }])), driftRefusal);
    assert.throws(() => projectHooksList(envelope([{ ...bundle, subscriptions: [{ ...bundle.subscriptions[0], priority: 100_001 }] }])), driftRefusal);
    assert.throws(() => projectHooksList(envelope([{ ...bundle, subscriptions: [{ ...bundle.subscriptions[0], event: 'session', phase: 'end' }] }])), driftRefusal);
    assert.throws(() => projectHooksList(envelope([{ ...bundle, subscriptions: [{ ...bundle.subscriptions[0], command: 'cmd\nline' }] }])), driftRefusal);
    assert.throws(() => projectHooksList(envelope([{ ...bundle, subscriptions: [{ ...bundle.subscriptions[0], blocking: 'yes' }] }])), driftRefusal);
    assert.throws(() => projectHooksList(envelope([], [{ bundle: null, status: 'limit_reached',
      code: 'hook_bundle_limit_reached', omitted: 0 }])), driftRefusal);
    assert.throws(() => projectHooksList(envelope([], [{ bundle: 'x', status: 'skipped' }])), driftRefusal);
    assert.throws(() => projectHooksList(envelope([], [{ bundle: null, status: 'skipped',
      code: 'UPPER' }])), driftRefusal);
    const absent = projectHooksList(await f.service.list());
    assert.throws(() => projectHooksList({ ...absent, hooks: [bundle], count: 1 }), driftRefusal);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('http serves the catalog pin, refuses wrong methods and unauthorized callers', async () => {
  const server = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(), token,
    host: '127.0.0.1', port: 0, nndRuntime: { getHost: () => null,
      snapshot: () => ({ service_state: 'setup_required', execution_state: 'unavailable' }) },
    resolvePrincipal: () => principal,
    nndHooksSettingsService: Object.freeze({ list: async () => ({ installationId: identity.installation_id,
      dataId: identity.data_id, sourceState: 'absent', count: 0, hooks: [], diagnostics: [] }) }) });
  try {
    const base = `http://127.0.0.1:${server.address.port}/v1/nnd/configuration/hooks`;
    const call = async (suffix = '', { method = 'GET', bearer = token } = {}) => {
      const response = await fetch(base + suffix, { method,
        headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) } });
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    const catalog = await call('/catalog');
    assert.equal(catalog.status, 200);
    assert.deepEqual(catalog.body.fields.map((entry) => entry.path), ['name', 'version',
      'subscriptions[*].event', 'subscriptions[*].phase', 'subscriptions[*].command',
      'subscriptions[*].blocking', 'subscriptions[*].priority', 'subscriptions[*].timeout_ms',
      'subscriptions[*].max_concurrent']);
    assert.equal(catalog.body.fields.filter((entry) => entry.classification === 'package_identity').length, 1);
    const list = await call('');
    assert.equal(list.status, 200);
    assert.equal(list.body.source_state, 'absent');
    assert.equal(list.body.application, 'next_hook_use');
    assert.equal((await call('', { method: 'POST' })).status, 405);
    assert.equal((await call('/bundles')).status, 404);
    assert.equal((await call('?refresh=1')).status, 400);
    assert.equal((await call('', { bearer: '' })).status, 401);
    const deniedServer = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(), token,
      host: '127.0.0.1', port: 0, nndRuntime: { getHost: () => null,
        snapshot: () => ({ service_state: 'setup_required', execution_state: 'unavailable' }) },
      resolvePrincipal: () => ({ subjectId: 'limited@example.com', permissions: ['nnd.read'] }),
      nndHooksSettingsService: Object.freeze({ list: async () => ({ installationId: identity.installation_id,
        dataId: identity.data_id, sourceState: 'absent', count: 0, hooks: [], diagnostics: [] }) }) });
    try {
      const denied = await fetch(`http://127.0.0.1:${deniedServer.address.port}/v1/nnd/configuration/hooks`,
        { headers: { authorization: `Bearer ${token}` } });
      assert.equal(denied.status, 403);
    } finally { await deniedServer.close(); }
  } finally { await server.close(); }
});
