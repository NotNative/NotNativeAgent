// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { configureInstalledService } from './serve-installed.mjs';

test('installed service is loopback-only and suppresses unavailable browser bridge', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nnd-installed-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = join(root, 'nna-integration/nnd-local/integration.json');
  const bundle = join(root, 'packages/electron/dist-server/server.mjs');
  const web = join(root, 'packages/web/dist/index.html');
  for (const file of [manifest, bundle, web]) await mkdir(dirname(file), { recursive: true });
  await writeFile(manifest, JSON.stringify({ id: 'nnd-local', ownership: 'nnd', scope: 'local-gui',
    nna_integration_protocol: '1.0', version: '20260926-58' }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '20260926.0.58', nnd_version: '20260926-58' }));
  await writeFile(bundle, ''); await writeFile(web, '');
  const environment = { NOTNATIVE_HOST: '0.0.0.0', NOTNATIVE_BROWSER_BRIDGE: 'enabled' };
  assert.throws(() => configureInstalledService(['--port', '0'], { root, environment }), /usage/u);
  assert.throws(() => configureInstalledService(['--port', '65536'], { root, environment }), /between/u);
  const configured = configureInstalledService(['--port', '57123'], { root, environment });
  assert.equal(configured.port, 57123);
  assert.equal(configured.version, '20260926-58');
  assert.equal(environment.NOTNATIVE_HOST, '127.0.0.1');
  assert.equal(environment.NOTNATIVE_BROWSER_BRIDGE, 'disabled');
  assert.equal(environment.NNA_NND_INSTALL_ROOT, root);
  assert.equal(environment.NOTNATIVE_NNA_MODE, 'managed');
  assert.equal(environment.NOTNATIVE_APP_VERSION, '20260926.0.58');
  const validIdentity = JSON.parse(await readFile(manifest, 'utf8'));
  await writeFile(manifest, JSON.stringify({ ...validIdentity, service_activation: {} }));
  const untouched = {};
  assert.throws(() => configureInstalledService(['--port', '57123'], { root, environment: untouched }),
    { code: 'nnd_package_manifest_invalid' });
  assert.deepEqual(untouched, {});
  await writeFile(manifest, JSON.stringify({ id: 'wrong' }));
  assert.throws(() => configureInstalledService(['--port', '57123'], { root, environment }), /incompatible/u);
});
