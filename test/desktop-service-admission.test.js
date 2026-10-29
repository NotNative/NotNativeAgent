// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { createScratchSync, reserveScratch } from './scratch.js';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rm, realpath, copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { userDataPaths, ensureUserDataPaths } from '../src/product.js';
import { acquireDesktopServiceLock } from '../src/desktop-service-lock.js';
import { admitFreshDesktopServiceData } from '../src/desktop-service-admission.js';
import { scanDesktopLegacyOwners } from '../src/desktop-legacy-census.js';

const windows = { skip: process.platform !== 'win32', timeout: 20000 };
async function fixture(t) {
  const root = reserveScratch('nna adoption');
  const result = spawnSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; $p=[Console]::In.ReadToEnd();
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $acl=[Security.AccessControl.DirectorySecurity]::new();
    $acl.SetSecurityDescriptorSddlForm('O:'+$sid+'D:P(A;OICI;FA;;;'+$sid+')(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)');
    [void][IO.Directory]::CreateDirectory($p,$acl)`], { input: root, encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const paths = await ensureUserDataPaths(userDataPaths({ environment: { NNA_HOME: root } }));
  const data = await realpath(root);
  const identity = { installation_id: `nna_${'a'.repeat(64)}`, data_id: `data_${createHash('sha256').update(data.toLowerCase()).digest('hex')}`,
    data_root: data, node: process.execPath };
  const lease = await acquireDesktopServiceLock({ dataRoot: data });
  t.after(async () => { await lease.close(); await rm(root, { recursive: true, force: true }); });
  return { root, paths, identity, lease };
}
test('configured NNA adoption preserves manifest, TUI tabs and ordinary journal bytes', windows, async (t) => {
  const f = await fixture(t);
  const files = [join(f.paths.config, 'manifest.json'), join(f.paths.rootTui, 'pool.json'), join(f.paths.sessions, 'tui-session.journal.ndjson')];
  for (const file of files) await writeFile(file, `preserved:${file}`);
  const receipt = await admitFreshDesktopServiceData(f.paths, f.identity, f.lease);
  assert.equal(receipt.basis, 'no_nnd_catalog'); assert.equal(receipt.census.legacy, 0);
  for (const file of files) assert.equal(await readFile(file, 'utf8'), `preserved:${file}`);
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'runtime/desktop/admission.json'), 'utf8')), receipt);
  await assert.rejects(admitFreshDesktopServiceData(f.paths, f.identity, {}), { code: 'desktop_lock_lost' });
});
test('desktop sidecars without catalog still require migration and are preserved', windows, async (t) => {
  const f = await fixture(t); const directory = join(f.paths.sessions, 'desktop-contexts.json.children');
  await mkdir(directory); await writeFile(join(directory, 'evidence.json'), 'preserve');
  await assert.rejects(admitFreshDesktopServiceData(f.paths, f.identity, f.lease), { code: 'desktop_owner_unverified' });
  assert.equal(await readFile(join(directory, 'evidence.json'), 'utf8'), 'preserve');
});
test('prior fresh-service receipt preserves supervised catalogs but foreign receipts fail closed', windows, async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.paths.config, 'desktop-supervised-owner.json'), JSON.stringify({ version: '1.0', data_id: f.identity.data_id, installation_id: f.identity.installation_id }));
  await writeFile(join(f.paths.sessions, 'desktop-contexts.json'), 'existing-supervised');
  assert.equal((await admitFreshDesktopServiceData(f.paths, f.identity, f.lease)).basis, 'prior_supervised_admission');
  await assert.rejects(admitFreshDesktopServiceData(f.paths, { ...f.identity, installation_id: `nna_${'b'.repeat(64)}` }, f.lease), { code: 'desktop_owner_unverified' });
  await writeFile(join(f.root, 'runtime/desktop/admission.json'), '{interrupted');
  await assert.rejects(admitFreshDesktopServiceData(f.paths, f.identity, f.lease), { code: 'desktop_owner_unverified' });
  assert.equal(await readFile(join(f.paths.sessions, 'desktop-contexts.json'), 'utf8'), 'existing-supervised');
});
test('actual Windows census recognizes quoted selected renamed Node legacy process, not its TUI', windows, async (t) => {
  const f = await fixture(t); const node = join(f.root, `native-probe-${randomUUID()}.exe`);
  await copyFile(process.execPath, node);
  const cli = join(f.root, 'cli.js'); await writeFile(cli, "process.stdout.write('ready');setInterval(()=>{},1000)");
  for (const mode of ['tui', 'desktop']) {
    const child = spawn(node, [cli, mode, ...(mode === 'desktop' ? ['serve'] : [])], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const exited = once(child, 'exit');
    try {
      await once(child.stdout, 'data');
      if (mode === 'desktop') await assert.rejects(scanDesktopLegacyOwners({ ...f.identity, node }), { code: 'desktop_owner_unverified' });
      else assert.equal((await scanDesktopLegacyOwners({ ...f.identity, node })).legacy, 0);
    } finally { child.kill(); await exited; }
  }
});
