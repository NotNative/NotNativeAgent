// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { createScratchSync, reserveScratch } from './scratch.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { hasActivationInitialization, withActivationInitialization } from '../src/desktop-activation-initialization-db.js';
import { assertNoDesktopInstallTransaction, readInstallBytes } from '../src/desktop-install-storage.js';
import { readDesktopActivationJournal } from '../src/desktop-activation-journal.js';
import { acquireDesktopServiceLock } from '../src/desktop-service-lock.js';
import { withManifestLock } from '../src/persistence/manifest-transaction.js';
import { preparationHarness, identityFor } from './support/desktop-activation-preparation-fixture.js';

const installRoot = fileURLToPath(new URL('../', import.meta.url));
async function fixture(t, withPrior = false) {
  const root = reserveScratch('nna-actprep');
  const script = `$ErrorActionPreference='Stop';$p=[Console]::In.ReadToEnd();
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$acl=[Security.AccessControl.DirectorySecurity]::new();
    $acl.SetSecurityDescriptorSddlForm('O:'+$sid+'D:P(A;OICI;FA;;;'+$sid+')(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)');
    [void][IO.Directory]::CreateDirectory($p,$acl)`;
  const created = spawnSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { input: root, encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.equal(created.status, 0, created.stderr);
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'config'));
  const identity = await identityFor(root, installRoot);
  const prior = Buffer.from('{"root":"C:\\prior","version":"20261001-1","protocol":"1.0"}\r\n');
  if (withPrior) await writeFile(join(root, 'config', 'desktop-package.json'), prior);
  return { identity, root, prior, stageId: randomUUID(), operationId: randomUUID(),
    journalDirectory: id => join(root, 'runtime', 'desktop', 'install-slots', 'activations', id) };
}
function childDeath(identity, stageId, operationId, phase) {
  const helper = new URL('./support/desktop-activation-preparation-fixture.js', import.meta.url).href;
  const script = `import { preparationHarness } from ${JSON.stringify(helper)};
    const identity=JSON.parse(process.argv[1]);const api=await preparationHarness(identity);
    await api.prepareDesktopActivation(identity,{stageOperationId:process.argv[2],operationId:process.argv[3],
      checkpoint:async name=>{if(name===process.argv[4])process.exit(71);}});`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script,
    JSON.stringify(identity), stageId, operationId, phase], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
}
test('preparation records exact prior bytes, candidate proof, journal and barrier without switching registration',
  { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
    const f = await fixture(t, true), api = await preparationHarness(f.identity);
    const result = await api.prepareDesktopActivation(f.identity, { stageOperationId: f.stageId, operationId: f.operationId });
    assert.equal(result.state, 'prepared');
    assert.equal(await hasActivationInitialization(f.root), false);
    assert.deepEqual(await readFile(join(f.root, 'config', 'desktop-package.json')), f.prior);
    assert.deepEqual(await readFile(join(f.root, 'runtime', 'desktop', 'install-slots', 'activations',
      `${f.operationId}.registration.before`)), f.prior);
    const journal = await readDesktopActivationJournal({ ...f.identity, operation_id: f.operationId }, f.journalDirectory(f.operationId));
    assert.deepEqual(journal.map(item => item.phase), ['prepared']);
    await assert.rejects(assertNoDesktopInstallTransaction(f.identity), { code: 'desktop_install_transaction_pending' });
    assert.equal((await api.recoverDesktopActivationPreparation(f.identity, { operationId: f.operationId })).state, 'prepared');
  });
test('lost prepared marker does not admit a service while activation evidence remains',
  { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
    const f = await fixture(t), api = await preparationHarness(f.identity);
    assert.equal((await api.prepareDesktopActivation(f.identity,
      { stageOperationId: f.stageId, operationId: f.operationId })).state, 'prepared');
    const marker = join(f.root, 'runtime', 'desktop', 'installation-pending.json');
    await unlink(marker);
    await assert.rejects(assertNoDesktopInstallTransaction(f.identity), { code: 'desktop_install_transaction_pending' });
    await assert.rejects(api.recoverDesktopActivationPreparation(f.identity, { operationId: f.operationId }),
      { code: 'desktop_activation_preparation_invalid' });
  });
test('held-owner preparation keeps singleton and registry ownership for the next activation phase',
  { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
    const f = await fixture(t), api = await preparationHarness(f.identity);
    const lease = await acquireDesktopServiceLock({ dataRoot: f.root });
    try {
      await withManifestLock(join(f.root, 'config', 'desktop-package.json'), {}, async registryLease => {
        const result = await api.prepareDesktopActivationUnderOwnership(f.identity, lease, registryLease,
          { stageOperationId: f.stageId, operationId: f.operationId });
        assert.equal(result.state, 'prepared');
        await assert.rejects(acquireDesktopServiceLock({ dataRoot: f.root }), { code: 'desktop_service_already_running' });
      });
    } finally { await lease.close(); }
  });
test('death after intent commit blocks service admission then safely removes known incomplete preparation',
  { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
    const f = await fixture(t), child = childDeath(f.identity, f.stageId, f.operationId, 'directory_created');
    assert.equal(child.status, 71, child.stderr);
    assert.equal(await hasActivationInitialization(f.root), true);
    await assert.rejects(assertNoDesktopInstallTransaction(f.identity), { code: 'desktop_install_transaction_pending' });
    const api = await preparationHarness(f.identity);
    assert.equal((await api.recoverDesktopActivationPreparation(f.identity, { operationId: f.operationId })).state, 'unpublished');
    assert.equal(await hasActivationInitialization(f.root), false);
    assert.equal(await readInstallBytes(join(f.root, 'runtime', 'desktop', 'installation-pending.json'), 1024, true), null);
  });
test('death after journal but before barrier preserves owned prefix and can reconcile to unpublished',
  { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
    const f = await fixture(t, true), child = childDeath(f.identity, f.stageId, f.operationId, 'journal_written');
    assert.equal(child.status, 71, child.stderr);
    const api = await preparationHarness(f.identity);
    const result = await api.recoverDesktopActivationPreparation(f.identity, { operationId: f.operationId });
    assert.equal(result.state, 'unpublished');
    assert.deepEqual(await readFile(join(f.root, 'config', 'desktop-package.json')), f.prior);
    assert.equal(await hasActivationInitialization(f.root), false);
  });
test('death after barrier before initializer clear recovers complete prepared state',
  { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
    const f = await fixture(t), child = childDeath(f.identity, f.stageId, f.operationId, 'barrier_written');
    assert.equal(child.status, 71, child.stderr);
    assert.equal(await hasActivationInitialization(f.root), true);
    const api = await preparationHarness(f.identity);
    assert.equal((await api.recoverDesktopActivationPreparation(f.identity, { operationId: f.operationId })).state, 'prepared');
    assert.equal(await hasActivationInitialization(f.root), false);
    await assert.rejects(assertNoDesktopInstallTransaction(f.identity), { code: 'desktop_install_transaction_pending' });
  });
test('changed prior registration or unknown evidence blocks recovery and preserves the barrier',
  { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
    const f = await fixture(t, true), child = childDeath(f.identity, f.stageId, f.operationId, 'journal_written');
    assert.equal(child.status, 71, child.stderr);
    const backup = join(f.root, 'runtime', 'desktop', 'install-slots', 'activations', `${f.operationId}.registration.before`);
    await writeFile(backup, Buffer.from('changed'));
    const api = await preparationHarness(f.identity);
    await assert.rejects(api.recoverDesktopActivationPreparation(f.identity, { operationId: f.operationId }));
    assert.equal(await hasActivationInitialization(f.root), true);
    assert.deepEqual(await readFile(backup), Buffer.from('changed'));
  });
test('foreign activation journal entry blocks recovery without deleting evidence',
  { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
    const f = await fixture(t), child = childDeath(f.identity, f.stageId, f.operationId, 'journal_written');
    assert.equal(child.status, 71, child.stderr);
    const foreign = join(f.journalDirectory(f.operationId), 'unexpected.txt');
    await writeFile(foreign, 'foreign');
    const api = await preparationHarness(f.identity);
    await assert.rejects(api.recoverDesktopActivationPreparation(f.identity, { operationId: f.operationId }));
    assert.equal(await hasActivationInitialization(f.root), true);
    assert.equal((await readFile(foreign, 'utf8')), 'foreign');
  });
test('admission refuses an initializer reached through an install-store junction',
  { skip: process.platform !== 'win32' }, async t => {
    const parent = createScratchSync('nna-actprep-link');
    const root = join(parent, 'root');
    const external = join(parent, 'external');
    const link = join(root, 'runtime', 'desktop', 'install-slots');
    await mkdir(join(root, 'runtime', 'desktop'), { recursive: true }); await mkdir(external);
    t.after(async () => { await unlink(link); await rm(parent, { recursive: true, force: true }); });
    await withActivationInitialization(external, async database => database.write('owned intent'));
    await symlink(external, link, 'junction');
    await assert.rejects(hasActivationInitialization(root), { code: 'desktop_activation_preparation_invalid' });
  });
