// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { assertRegisteredNndPackage, runNndPackageCommand, validateNndPackage } from '../src/nnd-package.js';
import { runNndIntegrationCommand } from '../src/integration-cli.js';
import { withManifestLock } from '../src/persistence/manifest-transaction.js';

const VERSION = '20260926-56';
async function fixture(root, version = VERSION) {
  for (const path of ['nna-integration/nnd-local/integration.json', 'package.json',
    'packages/electron/dist-server/server.mjs', 'packages/web/dist/index.html']) {
    await mkdir(dirname(join(root, path)), { recursive: true });
  }
  await writeFile(join(root, 'nna-integration/nnd-local/integration.json'), JSON.stringify({
    id: 'nnd-local', ownership: 'nnd', scope: 'local-gui', nna_integration_protocol: '1.0', version,
  }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ nnd_version: version }));
  await writeFile(join(root, 'packages/electron/dist-server/server.mjs'), '');
  await writeFile(join(root, 'packages/web/dist/index.html'), '');
}

test('registration waits for the shared slot mutex and refuses unresolved installation evidence', async t => {
  const temp = await mkdtemp(join(process.platform === 'win32' ? homedir() : tmpdir(), 'nna-registration-mutex-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, 'package'), config = join(temp, 'config'), paths = { root: temp, config };
  await mkdir(config); await fixture(root);
  let release, acquired;
  const held = new Promise(resolve => { acquired = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const owner = withManifestLock(join(config, 'nnd-package.json'), {}, async () => { acquired(); await gate; });
  await held;
  let published = false;
  const registration = runNndPackageCommand(['activate', root], paths).then(result => { published = true; return result; });
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(published, false);
  } finally { release(); await owner; }
  assert.equal((await registration).registered, true);
  const before = await readFile(join(config, 'nnd-package.json'));
  await mkdir(join(temp, 'runtime/nnd'), { recursive: true });
  await writeFile(join(temp, 'runtime/nnd/installation-pending.json'), 'unknown pending evidence');
  await assert.rejects(runNndPackageCommand(['deactivate', root], paths), { code: 'nnd_install_transaction_pending' });
  assert.deepEqual(await readFile(join(config, 'nnd-package.json')), before);
});

test('malformed registration remains a failure rather than appearing unregistered', async t => {
  const root = await mkdtemp(join(process.platform === 'win32' ? homedir() : tmpdir(), 'nna-registration-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'nnd-package.json');
  await writeFile(path, '{"root":');
  await assert.rejects(runNndPackageCommand(['status'], { config: root }), { code: 'nnd_package_registry_invalid' });
  assert.equal(await readFile(path, 'utf8'), '{"root":');
});

test('registers only a complete version-matched NND package and reports drift', async (t) => {
  const temp = await mkdtemp(join(process.platform === 'win32' ? homedir() : tmpdir(), 'nna-nnd-package-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, 'nnd');
  const config = join(temp, 'config');
  await mkdir(config); await fixture(root);
  const paths = { config };
  assert.deepEqual(await runNndPackageCommand(['status'], paths), { registered: false });
  assert.match((await runNndPackageCommand(['activate', root], paths)).version, /^20260926-56$/u);
  assert.equal((await runNndPackageCommand(['activate', root], paths)).registered, true);
  assert.equal((await assertRegisteredNndPackage(root, paths)).valid, true);
  await assert.rejects(assertRegisteredNndPackage(join(temp, 'other'), paths), { code: 'nnd_package_not_active' });
  assert.deepEqual(await runNndPackageCommand(['status'], paths), { registered: true, valid: true, root, version: VERSION });
  await assert.rejects(runNndPackageCommand(['deactivate', join(temp, 'other')], paths), { code: 'nnd_package_root_mismatch' });
  await writeFile(join(root, 'package.json'), JSON.stringify({ nnd_version: '20260926-57' }));
  assert.deepEqual(await runNndPackageCommand(['status'], paths), {
    registered: true, valid: false, root, version: VERSION, reason: 'nnd_package_manifest_invalid',
  });
  await assert.rejects(assertRegisteredNndPackage(root, paths), { code: 'nnd_package_not_active' });
  const uninstallPath = process.platform === 'win32' ? root.toUpperCase() : root;
  assert.deepEqual(await runNndPackageCommand(['deactivate', uninstallPath], paths), { registered: false });
  assert.deepEqual(await runNndPackageCommand(['status'], paths), { registered: false });
  await assert.rejects(assertRegisteredNndPackage(root, paths), { code: 'nnd_package_not_active' });
});

test('installed NND serve rejects an unregistered package before engine startup', async (t) => {
  const temp = await mkdtemp(join(process.platform === 'win32' ? homedir() : tmpdir(), 'nna-nnd-package-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const config = join(temp, 'config'); await mkdir(config);
  await assert.rejects(runNndIntegrationCommand(['serve'], { config }, {
    environment: { NNA_NND_INSTALL_ROOT: join(temp, 'missing') },
  }), { code: 'nnd_package_not_active' });
});

test('rejects incompatible metadata, missing assets, and escaping symlink', async (t) => {
  const temp = await mkdtemp(join(process.platform === 'win32' ? homedir() : tmpdir(), 'nna-nnd-package-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, 'nnd'); await fixture(root);
  await assert.rejects(validateNndPackage('relative'), { code: 'nnd_package_root_invalid' });
  const manifest = join(root, 'nna-integration/nnd-local/integration.json');
  const original = await readFile(manifest, 'utf8');
  await writeFile(manifest, JSON.stringify({ ...JSON.parse(original), nna_integration_protocol: '2.0' }));
  await assert.rejects(validateNndPackage(root), { code: 'nnd_package_manifest_invalid' });
  await writeFile(manifest, original);
  await rm(join(root, 'packages/web/dist/index.html'));
  await assert.rejects(validateNndPackage(root), { code: 'nnd_package_incomplete' });
  try { await symlink(manifest, join(root, 'packages/web/dist/index.html')); }
  catch (error) { if (error.code === 'EPERM') return; throw error; }
  assert.equal((await validateNndPackage(root)).version, VERSION);
  await rm(join(root, 'packages/web/dist/index.html'));
  const outside = join(temp, 'outside.html'); await writeFile(outside, '');
  await symlink(outside, join(root, 'packages/web/dist/index.html'));
  await assert.rejects(validateNndPackage(root), { code: 'nnd_package_incomplete' });
});

test('registration validates the package after acquiring the shared writer mutex', async t => {
  const temp=await mkdtemp(join(process.platform==='win32'?homedir():tmpdir(),'nna-registration-recheck-'));
  t.after(()=>rm(temp,{recursive:true,force:true}));
  const root=join(temp,'package'),config=join(temp,'config');await mkdir(config);await fixture(root);
  let release,entered;const ready=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const owner=withManifestLock(join(config,'nnd-package.json'),{},async()=>{entered();await gate;});
  await ready;
  const pending=runNndPackageCommand(['activate',root],{config});
  const rejected=assert.rejects(pending,{code:'nnd_package_manifest_invalid'});
  try {
    await new Promise(resolve=>setTimeout(resolve,500));
    await writeFile(join(root,'package.json'),JSON.stringify({nnd_version:'20260926-57'}));
  } finally {release();await owner;}
  await rejected;
  assert.deepEqual(await runNndPackageCommand(['status'],{config}),{registered:false});
});
test('registry version arrays remain malformed rather than being coerced into versions', async t => {
  const config=await mkdtemp(join(process.platform==='win32'?homedir():tmpdir(),'nna-registry-version-'));
  t.after(()=>rm(config,{recursive:true,force:true}));
  const path=join(config,'nnd-package.json'),bytes=JSON.stringify({root:config,version:[VERSION],protocol:'1.0'});
  await writeFile(path,bytes);
  await assert.rejects(runNndPackageCommand(['status'],{config}),{code:'nnd_package_registry_invalid'});
  assert.equal(await readFile(path,'utf8'),bytes);
});
test('package metadata rejects oversized files and invalid UTF-8 without replacement decoding', async t => {
  const root=await mkdtemp(join(process.platform==='win32'?homedir():tmpdir(),'nna-package-metadata-'));
  t.after(()=>rm(root,{recursive:true,force:true}));await fixture(root);
  const path=join(root,'package.json');await writeFile(path,JSON.stringify({nnd_version:VERSION,padding:'x'.repeat(16384)}));
  await assert.rejects(validateNndPackage(root),{code:'nnd_package_manifest_invalid'});
  await writeFile(path,Buffer.concat([Buffer.from(`{"nnd_version":"${VERSION}","ignored":"`),Buffer.from([255]),Buffer.from('"}') ]));
  await assert.rejects(validateNndPackage(root),{code:'nnd_package_manifest_invalid'});
});
