// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { createScratchSync } from './scratch.js';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { assertRegisteredDesktopPackage, runDesktopPackageCommand, validateDesktopPackage } from '../src/desktop-package.js';
import { runDesktopIntegrationCommand } from '../src/integration-cli.js';
import { withManifestLock } from '../src/persistence/manifest-transaction.js';

const VERSION = '20260926-56';
async function fixture(root, version = VERSION) {
  for (const path of ['nna-integration/desktop-local/integration.json', 'package.json',
    'packages/electron/dist-server/server.mjs', 'packages/web/dist/index.html']) {
    await mkdir(dirname(join(root, path)), { recursive: true });
  }
  await writeFile(join(root, 'nna-integration/desktop-local/integration.json'), JSON.stringify({
    id: 'desktop-local', ownership: 'desktop', scope: 'local-gui', nna_integration_protocol: '1.0', version,
  }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ desktop_version: version }));
  await writeFile(join(root, 'packages/electron/dist-server/server.mjs'), '');
  await writeFile(join(root, 'packages/web/dist/index.html'), '');
}

test('registration waits for the shared slot mutex and refuses unresolved installation evidence', async t => {
  const temp = createScratchSync('nna-registration-mutex-');
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, 'package'), config = join(temp, 'config'), paths = { root: temp, config };
  await mkdir(config); await fixture(root);
  let release, acquired;
  const held = new Promise(resolve => { acquired = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const owner = withManifestLock(join(config, 'desktop-package.json'), {}, async () => { acquired(); await gate; });
  await held;
  let published = false;
  const registration = runDesktopPackageCommand(['activate', root], paths).then(result => { published = true; return result; });
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(published, false);
  } finally { release(); await owner; }
  assert.equal((await registration).registered, true);
  const before = await readFile(join(config, 'desktop-package.json'));
  await mkdir(join(temp, 'runtime/desktop'), { recursive: true });
  await writeFile(join(temp, 'runtime/desktop/installation-pending.json'), 'unknown pending evidence');
  await assert.rejects(runDesktopPackageCommand(['deactivate', root], paths), { code: 'desktop_install_transaction_pending' });
  await assert.rejects(runDesktopPackageCommand(['deactivate', root], { config }),
    { code: 'desktop_package_data_root_invalid' });
  // Security: an unrelated absolute root cannot make the registry's own pending barrier disappear.
  await assert.rejects(runDesktopPackageCommand(['deactivate', root], { root: join(temp, 'elsewhere'), config }),
    { code: 'desktop_package_data_root_invalid' });
  await assert.rejects(readFile(join(temp, 'elsewhere', 'config', 'desktop-package.json')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(config, 'desktop-package.json')), before);
});

test('registry mutation refuses a config directory redirected outside its data root', async t => {
  const root = createScratchSync('nna-registration-pair-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const other = join(root, 'other'), config = join(root, 'config');
  await mkdir(other);
  try { await symlink(other, config, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') return; throw error; }
  await assert.rejects(runDesktopPackageCommand(['deactivate', root], { root, config }),
    { code: 'desktop_package_data_root_invalid' });
  await assert.rejects(readFile(join(other, 'desktop-package.json')), { code: 'ENOENT' });
});

test('malformed registration remains a failure rather than appearing unregistered', async t => {
  const root = createScratchSync('nna-registration-invalid-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'desktop-package.json');
  await writeFile(path, '{"root":');
  await assert.rejects(runDesktopPackageCommand(['status'], { config: root }), { code: 'desktop_package_registry_invalid' });
  assert.equal(await readFile(path, 'utf8'), '{"root":');
});

test('registers only a complete version-matched desktop package and reports drift', async (t) => {
  const temp = createScratchSync('nna-desktop-package-');
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, 'desktop');
  const config = join(temp, 'config');
  await mkdir(config); await fixture(root);
  const paths = { root: temp, config };
  assert.deepEqual(await runDesktopPackageCommand(['status'], paths), { registered: false });
  assert.match((await runDesktopPackageCommand(['activate', root], paths)).version, /^20260926-56$/u);
  assert.equal((await runDesktopPackageCommand(['activate', root], paths)).registered, true);
  assert.equal((await assertRegisteredDesktopPackage(root, paths)).valid, true);
  await assert.rejects(assertRegisteredDesktopPackage(join(temp, 'other'), paths), { code: 'desktop_package_not_active' });
  assert.deepEqual(await runDesktopPackageCommand(['status'], paths), { registered: true, valid: true, root, version: VERSION });
  await assert.rejects(runDesktopPackageCommand(['deactivate', join(temp, 'other')], paths), { code: 'desktop_package_root_mismatch' });
  await writeFile(join(root, 'package.json'), JSON.stringify({ desktop_version: '20260926-57' }));
  assert.deepEqual(await runDesktopPackageCommand(['status'], paths), {
    registered: true, valid: false, root, version: VERSION, reason: 'desktop_package_manifest_invalid',
  });
  await assert.rejects(assertRegisteredDesktopPackage(root, paths), { code: 'desktop_package_not_active' });
  const uninstallPath = process.platform === 'win32' ? root.toUpperCase() : root;
  assert.deepEqual(await runDesktopPackageCommand(['deactivate', uninstallPath], paths), { registered: false });
  assert.deepEqual(await runDesktopPackageCommand(['status'], paths), { registered: false });
  await assert.rejects(assertRegisteredDesktopPackage(root, paths), { code: 'desktop_package_not_active' });
});

test('installed desktop serve rejects an unregistered package before engine startup', async (t) => {
  const temp = createScratchSync('nna-desktop-package-');
  t.after(() => rm(temp, { recursive: true, force: true }));
  const config = join(temp, 'config'); await mkdir(config);
  await assert.rejects(runDesktopIntegrationCommand(['serve'], { config }, {
    environment: { NNA_DESKTOP_INSTALL_ROOT: join(temp, 'missing') },
  }), { code: 'desktop_package_not_active' });
});

test('rejects incompatible metadata, missing assets, and escaping symlink', async (t) => {
  const temp = createScratchSync('nna-desktop-package-');
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, 'desktop'); await fixture(root);
  await assert.rejects(validateDesktopPackage('relative'), { code: 'desktop_package_root_invalid' });
  const manifest = join(root, 'nna-integration/desktop-local/integration.json');
  const original = await readFile(manifest, 'utf8');
  await writeFile(manifest, JSON.stringify({ ...JSON.parse(original), nna_integration_protocol: '2.0' }));
  await assert.rejects(validateDesktopPackage(root), { code: 'desktop_package_manifest_invalid' });
  await writeFile(manifest, original);
  await rm(join(root, 'packages/web/dist/index.html'));
  await assert.rejects(validateDesktopPackage(root), { code: 'desktop_package_incomplete' });
  try { await symlink(manifest, join(root, 'packages/web/dist/index.html')); }
  catch (error) { if (error.code === 'EPERM') return; throw error; }
  assert.equal((await validateDesktopPackage(root)).version, VERSION);
  await rm(join(root, 'packages/web/dist/index.html'));
  const outside = join(temp, 'outside.html'); await writeFile(outside, '');
  await symlink(outside, join(root, 'packages/web/dist/index.html'));
  await assert.rejects(validateDesktopPackage(root), { code: 'desktop_package_incomplete' });
});

test('registration validates the package after acquiring the shared writer mutex', async t => {
  const temp=createScratchSync('nna-registration-recheck-');
  t.after(()=>rm(temp,{recursive:true,force:true}));
  const root=join(temp,'package'),config=join(temp,'config');await mkdir(config);await fixture(root);
  let release,entered;const ready=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const owner=withManifestLock(join(config,'desktop-package.json'),{},async()=>{entered();await gate;});
  await ready;
  const pending=runDesktopPackageCommand(['activate',root],{root:temp,config});
  const rejected=assert.rejects(pending,{code:'desktop_package_manifest_invalid'});
  try {
    await new Promise(resolve=>setTimeout(resolve,500));
    await writeFile(join(root,'package.json'),JSON.stringify({desktop_version:'20260926-57'}));
  } finally {release();await owner;}
  await rejected;
  assert.deepEqual(await runDesktopPackageCommand(['status'],{config}),{registered:false});
});
test('registry version arrays remain malformed rather than being coerced into versions', async t => {
  const config=createScratchSync('nna-registry-version-');
  t.after(()=>rm(config,{recursive:true,force:true}));
  const path=join(config,'desktop-package.json'),bytes=JSON.stringify({root:config,version:[VERSION],protocol:'1.0'});
  await writeFile(path,bytes);
  await assert.rejects(runDesktopPackageCommand(['status'],{config}),{code:'desktop_package_registry_invalid'});
  assert.equal(await readFile(path,'utf8'),bytes);
});
test('package metadata rejects oversized files and invalid UTF-8 without replacement decoding', async t => {
  const root=createScratchSync('nna-package-metadata-');
  t.after(()=>rm(root,{recursive:true,force:true}));await fixture(root);
  const path=join(root,'package.json');await writeFile(path,JSON.stringify({desktop_version:VERSION,padding:'x'.repeat(16384)}));
  await assert.rejects(validateDesktopPackage(root),{code:'desktop_package_manifest_invalid'});
  await writeFile(path,Buffer.concat([Buffer.from(`{"desktop_version":"${VERSION}","ignored":"`),Buffer.from([255]),Buffer.from('"}') ]));
  await assert.rejects(validateDesktopPackage(root),{code:'desktop_package_manifest_invalid'});
});
