// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const registration = { root: 'C:/NND', version: '20261010-36', protocol: '1.0' };

async function harness(overrides = {}) {
  const source = await readFile(new URL('../src/nnd-lifecycle.js', import.meta.url), 'utf8');
  const executable = source.replace(/^import .*?;\r?\n/gmu, '').replaceAll('export async function ', 'async function ');
  const trace = [];
  const state = { enabled: false, files: { '/nna/install.json': '{}' } };
  const dependencies = {
    join: (...parts) => parts.join('/'),
    dirname: value => value.replace(/\/[^/]+$/u, ''),
    spawn: overrides.spawn ?? (() => { trace.push('spawn'); return { on() {}, unref() {} }; }),
    existsSync: value => Boolean(state.files[value]),
    readFile: async path => {
      if (!(path in state.files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return state.files[path];
    },
    realpath: async value => value,
    delay: async () => {},
    ContractError: class ContractError extends Error {
      constructor(code, message, options) { super(message); this.code = code; this.cause = options?.cause; }
    },
    readNndPackageRegistration: overrides.readNndPackageRegistration ?? (async () => registration),
    readNndServiceIdentity: async root => ({ install_root: root, cli_path: `${root}/cli.js`, node: 'node', data_root: `${root}/data` }),
    readNndServiceDiscovery: overrides.readNndServiceDiscovery ?? (async () => ({ instance_id: 'gen-1' })),
    requestNndController: overrides.requestNndController ?? (async (record, action) => {
      trace.push(`controller:${action}`);
      return action === 'status' ? { service_state: 'ready' } : { stopped: true };
    }),
    nativeEnvironment: () => ({}),
    persistAtomicJson: async (path, value) => { state.files[path] = JSON.stringify(value); trace.push(`persist:${path}`); },
  };
  const api = Function('process', ...Object.keys(dependencies), `${executable}\nreturn { runNndLifecycleCommand };`)
    ({ argv: ['/node', overrides.cliPath ?? '/nna/src/cli.js'] }, ...Object.values(dependencies));
  return { api, trace, state, paths: { config: '/nna/config' } };
}

test('start and enable fail gracefully when no NND package is registered', async () => {
  const f = await harness({ readNndPackageRegistration: async () => null });
  await assert.rejects(f.api.runNndLifecycleCommand(['start'], f.paths), { code: 'nnd_plugin_not_installed' });
  await assert.rejects(f.api.runNndLifecycleCommand(['enable'], f.paths), { code: 'nnd_plugin_not_installed' });
  assert.equal(f.trace.length, 0);
});

test('stop, disable and status are silent no-ops without an installation', async () => {
  const f = await harness({ readNndPackageRegistration: async () => null });
  for (const action of ['stop', 'disable', 'status']) {
    assert.equal(await f.api.runNndLifecycleCommand([action], f.paths), null);
  }
  assert.equal(f.trace.length, 0);
});

test('start takes over a stale controller record through a foreground supervisor run', async () => {
  const spawned = [];
  let discoveryAttempts = 0;
  const f = await harness({
    readNndServiceDiscovery: async () => {
      discoveryAttempts += 1;
      return discoveryAttempts === 1 ? { instance_id: 'stale' } : { instance_id: 'fresh' };
    },
    requestNndController: async (record, action) => {
      if (record.instance_id === 'stale') throw Object.assign(new Error('dead'), { code: 'nnd_owner_unverified' });
      return { service_state: 'ready', via: action };
    },
    spawn: (node, args, childOptions) => {
      spawned.push({ node, args, detached: childOptions.detached, windowsHide: childOptions.windowsHide });
      return { on() {}, unref() {} };
    },
  });
  const result = await f.api.runNndLifecycleCommand(['start'], f.paths);
  assert.equal(result.service_state, 'ready');
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].args.join(' '), '/nna/cli.js nnd service run /nna');
  assert.equal(spawned[0].detached, true);
  assert.equal(spawned[0].windowsHide, true);
});

test('status reports the registered package with runtime and enablement', async () => {
  const f = await harness();
  const status = await f.api.runNndLifecycleCommand(['status'], f.paths);
  assert.deepEqual(status, { root: registration.root, version: registration.version, enabled: false,
    running: true, service: { service_state: 'ready' } });
});

test('stop without a running controller is a quiet no-op', async () => {
  const f = await harness({ readNndServiceDiscovery: async () => null });
  assert.deepEqual(await f.api.runNndLifecycleCommand(['stop'], f.paths), { running: false });
  assert.equal(f.trace.length, 0);
});

test('enable and disable persist the lifecycle flag under the NNA config', async () => {
  const f = await harness();
  const enabled = await f.api.runNndLifecycleCommand(['enable'], f.paths);
  assert.deepEqual(enabled, { enabled: true });
  assert.deepEqual(JSON.parse(f.state.files['/nna/config/nnd-service.json']).enabled, true);
  assert.deepEqual(await f.api.runNndLifecycleCommand(['disable'], f.paths), { enabled: false });
  assert.deepEqual(JSON.parse(f.state.files['/nna/config/nnd-service.json']).enabled, false);
});

test('unknown actions and malformed registrations are rejected without spawning anything', async () => {
  const f = await harness({ readNndPackageRegistration: async () => ({ root: 'C:/NND' }) });
  await assert.rejects(f.api.runNndLifecycleCommand(['restart'], f.paths), { code: 'nnd_command_invalid' });
  await assert.rejects(f.api.runNndLifecycleCommand(['status'], f.paths), { code: 'nnd_package_registry_invalid' });
  assert.equal(f.trace.length, 0);
});
