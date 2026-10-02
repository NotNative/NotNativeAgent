// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { validateNndPackage, runNndPackageCommand } from '../src/nnd-package.js';

const HOST = { platform: 'win32', architecture: 'x64', node_major: 24,
  capabilities: ['service_supervision', 'setup_control_plane'], data_schemas: { nnd_catalog: 1, nnd_state: 1 } };
async function fixture(t) {
  const root = await mkdtemp(join(process.platform === 'win32' ? homedir() : tmpdir(), 'nna-service-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = { id: 'nnd-local', ownership: 'nnd', scope: 'local-gui',
    nna_integration_protocol: '1.0', version: '20261001-42', service_activation: {
      schema_version: '1.0', required_capabilities: HOST.capabilities, data_schemas: HOST.data_schemas,
      platform: 'win32', architecture: 'x64', runtime: { name: 'node', minimum_major: 24 },
      entrypoint: 'scripts/serve-installed.mjs', bundle_identity: {
        path: 'packages/electron/dist-server/server.mjs', sha256: createHash('sha256').update('bundle').digest('hex'),
      }, authenticated_callbacks: { token_exchange: 'protected_stdin', protocol: '1.0' },
    } };
  const files = { 'nna-integration/nnd-local/integration.json': JSON.stringify(manifest),
    'package.json': JSON.stringify({ nnd_version: manifest.version }),
    'scripts/serve-installed.mjs': 'entry', 'packages/electron/dist-server/server.mjs': 'bundle',
    'packages/web/dist/index.html': 'web' };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return { root, manifest };
}
test('service package checks host capability and artifact bytes before registration mutation', async (t) => {
  const { root } = await fixture(t);
  const config = join(root, 'config'); await mkdir(config);
  await validateNndPackage(root, { serviceHost: HOST });
  await assert.rejects(validateNndPackage(root, { serviceHost: { ...HOST, capabilities: [] } }),
    { code: 'nnd_package_incompatible' });
  await runNndPackageCommand(['activate', root], { config });
  const registry = await readFile(join(config, 'nnd-package.json'), 'utf8');
  await writeFile(join(root, 'packages/electron/dist-server/server.mjs'), 'modified');
  await assert.rejects(runNndPackageCommand(['activate', root], { config }), { code: 'nnd_package_manifest_invalid' });
  assert.equal(await readFile(join(config, 'nnd-package.json'), 'utf8'), registry);
});
test('service activation requires metadata and refuses escaped entrypoints', async (t) => {
  const { root, manifest } = await fixture(t);
  const path = join(root, 'nna-integration/nnd-local/integration.json');
  delete manifest.service_activation;
  await writeFile(path, JSON.stringify(manifest));
  await validateNndPackage(root);
  await assert.rejects(validateNndPackage(root, { serviceHost: HOST }), { code: 'nnd_package_manifest_invalid' });
  const other = await fixture(t);
  await rm(join(other.root, 'scripts'), { recursive: true });
  await symlink(join(root, 'scripts'), join(other.root, 'scripts'), 'junction');
  await assert.rejects(validateNndPackage(other.root), { code: 'nnd_package_incomplete' });
});

test('service digest cannot identify an unrelated helper instead of the served bundle', async (t) => {
  const { root, manifest } = await fixture(t);
  await writeFile(join(root, 'scripts', 'helper.mjs'), 'bundle');
  manifest.service_activation.bundle_identity.path = 'scripts/helper.mjs';
  await writeFile(join(root, 'nna-integration/nnd-local/integration.json'), JSON.stringify(manifest));
  await writeFile(join(root, 'packages/electron/dist-server/server.mjs'), 'modified server');
  await assert.rejects(validateNndPackage(root), { code: 'nnd_package_manifest_invalid' });
});
