// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeInstalledServiceManifest, validateInstalledNndService } from './installed-service-package.mjs';
import { copyPrebuiltPayload } from './prebuilt-payload-validation.mjs';

export async function createSupervisedFixture(nna, nnd, { payloadRoot = null, nativeSlot = false } = {}) {
  if (nativeSlot && !payloadRoot) throw new Error('Native slot smoke requires a prebuilt payload');
  // Compatibility: keep disposable slot paths within external Windows runtime path limits.
  const root = join(homedir(), `.ns-${randomUUID().replaceAll('-', '').slice(0, 24)}`);
  const script = "$ErrorActionPreference='Stop'; $root=[Console]::In.ReadToEnd(); "
    + "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; "
    + "$acl=[Security.AccessControl.DirectorySecurity]::new(); "
    + "$acl.SetSecurityDescriptorSddlForm('O:'+$sid+'D:P(A;OICI;FA;;;'+$sid+')(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'); "
    + '[void][IO.Directory]::CreateDirectory($root,$acl)';
  const result = spawnSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', script], { input: root, encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.equal(result.status, 0, 'Private disposable fixture creation failed');
  try {
    const install = join(root, 'NNA'), payload = join(install, 'installed'), data = join(root, 'data');
    let gui = join(root, 'NND');
    await mkdir(payload, { recursive: true }); await mkdir(join(data, 'config'), { recursive: true }); await mkdir(gui);
    for (const path of ['src', 'resources', 'package.json', 'VERSION']) await cp(join(nna, path), join(payload, path), { recursive: true });
    if (payloadRoot) await copyPrebuiltPayload(payloadRoot, gui);
    else for (const path of ['scripts', 'packages/electron/dist-server', 'packages/web/dist', 'package.json', 'VERSION']) {
        await cp(join(nnd, path), join(gui, path), { recursive: true });
      }
    const version = (await readFile(join(payload, 'VERSION'), 'utf8')).trim();
    await writeFile(join(install, 'install.json'), JSON.stringify({ product: 'NotNativeAgent', version,
      install_root: install, data_root: data, node: process.execPath, node_major: Number(process.versions.node.split('.')[0]) }));
    const manifest = payloadRoot ? (await validateInstalledNndService(gui)).manifest : await writeInstalledServiceManifest(gui);
    if (payloadRoot) {
      const { validateNndPackage } = await import(pathToFileURL(join(payload, 'src/nnd-package.js')).href);
      const admitted = await validateNndPackage(gui);
      assert.equal(admitted.version, manifest.version);
    }
    if (nativeSlot) {
      const { readNndServiceIdentity } = await import(pathToFileURL(join(payload, 'src/nnd-service-identity.js')).href);
      const { stageNndInstallSlot, recoverNndInstallSlot } = await import(pathToFileURL(join(payload, 'src/nnd-install-slots.js')).href);
      const { runNndPackageCommand } = await import(pathToFileURL(join(payload, 'src/nnd-package.js')).href);
      const identity = await readNndServiceIdentity(install), operationId = randomUUID();
      const staged = await stageNndInstallSlot(identity, { source: gui, operationId });
      assert.equal(staged.state, 'slot_ready');
      assert.deepEqual(await runNndPackageCommand(['status'], { root: data, config: join(data, 'config') }), { registered: false });
      assert.deepEqual(await recoverNndInstallSlot(identity, { operationId }), staged);
      const repeated = await stageNndInstallSlot(identity, { source: gui, operationId: randomUUID() });
      assert.equal(repeated.slot, staged.slot);
      assert.equal(repeated.payload_sha256, staged.payload_sha256);
      gui = staged.slot;
      // Invariant: explicit fixture registration is separate from staging and proves no installer completion claim.
      await runNndPackageCommand(['activate', gui], { root: data, config: join(data, 'config') });
    } else {
      await writeFile(join(data, 'config/nnd-package.json'), JSON.stringify({ root: gui, version: manifest.version, protocol: '1.0' }));
    }
    return { root, install, data, gui, prebuilt: Boolean(payloadRoot), nativeSlot, cli: join(payload, 'src/cli.js') };
  } catch (error) {
    // A staging rejection can leave an owned filesystem operation draining.
    // Preserve its private receipt and payload until native recovery proves settlement.
    if (nativeSlot) process.stderr.write(`Native slot fixture failed; preserved disposable fixture: ${root}\n`);
    else await removeSupervisedFixture(root);
    throw error;
  }
}
export async function removeSupervisedFixture(root) {
  assert.equal(dirname(root), homedir());
  assert.match(root.slice(homedir().length), /^[\\/]\.ns-[a-f0-9]{24}$/u);
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
