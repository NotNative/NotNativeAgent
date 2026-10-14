// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const installationId = 'nna_' + '3'.repeat(64);
const dataId = 'data_' + '4'.repeat(64);

function values(base) {
  const data = join(base, 'nna-data');
  const slot = join(data, 'runtime', 'nnd', 'install-slots', 'versions', '20261004-4-' + 'a'.repeat(64));
  return {
    data, anchor: join(base, 'target'), slot,
    stage: '11111111-2222-4333-8444-555555555555',
    activation: '66666666-7777-4888-9999-aaaaaaaaaaaa',
  };
}

function run(root, helperFile, body) {
  const load = ". $env:NND_TEST_HELPER;$ErrorActionPreference='Stop';"
  return execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', load + body], {
    windowsHide: true, encoding: 'utf8', timeout: 12000,
    env: { ...process.env, NND_TEST_HELPER: resolve(helperFile), NND_TEST_ROOT: root },
  });
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nnd-prebuilt-uninstall-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const value = values(root);
  await mkdir(value.anchor, { recursive: true });
  await mkdir(join(value.slot, 'packages', 'web'), { recursive: true });
  await writeFile(join(value.slot, 'NND_PAYLOAD.json'), '{}');
  return { root, ...value };
}

async function writeBinding(value, selected) {
  await writeFile(join(value.anchor, 'nnd-anchor.json'), JSON.stringify({
    schema_version: '1.0', nna_install_root: selected.installRoot,
    nnd_package_root: value.slot, version: '20261004-4', data_schema: '1',
    payload_sha256: 'a'.repeat(64), candidate_sha256: 'b'.repeat(64),
    stage_operation_id: value.stage, activation_operation_id: value.activation,
    installation_id: installationId, data_id: dataId,
  }));
}

test('uninstall binds the public target to the exact selected NNA artifact', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const selected = { installRoot: join(f.root, 'nna-install') };
  await writeBinding(f, selected);
  const body = `
    $capabilities = @{ installation_id = '${installationId}'; data_id = '${dataId}' }
    $dir = '${f.anchor.replaceAll("'", "''")}'
    $nna = @{ InstallRoot = '${selected.installRoot.replaceAll("'", "''")}'; DataRoot = '${f.data.replaceAll("'", "''")}' }
    $result = Resolve-NndPrebuiltAnchorForUninstall $dir $nna $capabilities
    if($result.root -ne '${f.slot.replaceAll("'", "''")}'){throw 'Wrong slot'}
    if($result.version -ne '20261004-4'){throw 'Wrong version'}
    'resolved'
  `;
  const result = run(f.root, 'scripts/installer-prebuilt-uninstall.ps1', body);
  assert.match(result, /resolved/u);
});

test('uninstall refuses foreign, malformed, renamed and reparse-bound slots', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const selected = { installRoot: join(f.root, 'wrong-nna') };
  await writeBinding(f, { installRoot: join(f.root, 'nna-install') });
  await mkdir(selected.installRoot, { recursive: true });
  const body = (nativeRoot) => `
    $capabilities = @{ installation_id = '${installationId}'; data_id = '${dataId}' }
    $dir = '${f.anchor.replaceAll("'", "''")}'
    $nna = @{ InstallRoot = ${nativeRoot}; DataRoot = '${f.data.replaceAll("'", "''")}' }
    Resolve-NndPrebuiltAnchorForUninstall $dir $nna $capabilities | Out-Null
  `;
  assert.throws(() => run(f.root, 'scripts/installer-prebuilt-uninstall.ps1',
    body(`'${selected.installRoot.replaceAll("'", "''")}'`)), /matches the selected NNA/u);

  const bindingPath = join(f.anchor, 'nnd-anchor.json');
  await writeBinding(f, { installRoot: join(f.root, 'nna-install') });
  const malformed = (await readFile(bindingPath, 'utf8')).replace('"version":"20261004-4"', '"version":"not-a-version"');
  await writeFile(bindingPath, malformed);
  assert.throws(() => run(f.root, 'scripts/installer-prebuilt-uninstall.ps1',
    body(`'${join(f.root, 'nna-install').replaceAll("'", "''")}'`)), /binding is invalid/u);
  await writeBinding(f, { installRoot: join(f.root, 'nna-install') });

  const renamed = (await readFile(bindingPath, 'utf8')).replace(
    `"nnd_package_root":"${f.slot.replaceAll('\\', '\\\\')}"`,
    `"nnd_package_root":"${join(f.data, 'runtime', 'nnd', 'install-slots', 'versions', '20261004-4-' + 'b'.repeat(64)).replaceAll('\\', '\\\\')}"`
  );
  await mkdir(join(f.data, 'runtime', 'nnd', 'install-slots', 'versions'), { recursive: true });
  await mkdir(join(f.data, 'runtime', 'nnd', 'install-slots', 'versions', '20261004-4-' + 'b'.repeat(64)), { recursive: true });
  await writeFile(bindingPath, renamed);
  assert.throws(() => run(f.root, 'scripts/installer-prebuilt-uninstall.ps1',
    body(`'${join(f.root, 'nna-install').replaceAll("'", "''")}'`)), /package root is invalid/u);
  await writeBinding(f, { installRoot: join(f.root, 'nna-install') });

  const through = join(f.root, 'outside-slot');
  await mkdir(through, { recursive: true });
  try { await rm(f.slot, { recursive: true, force: true }); } catch {}
  await symlink(through, f.slot, 'junction');
  await writeBinding(f, { installRoot: join(f.root, 'nna-install') });
  assert.throws(() => run(f.root, 'scripts/installer-prebuilt-uninstall.ps1',
    body(`'${join(f.root, 'nna-install').replaceAll("'", "''")}'`)), /reparse point/u);
});

test('uninstall evidence requires exact native registration and guard identity', { skip: process.platform !== 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'nnd-uninstall-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, 'cli.mjs');
  const good = { registered: true, valid: true, root: join(root, 'slot'), version: '20261004-4' };
  const helperPath = resolve('scripts/installer-prebuilt-uninstall-evidence.ps1');
  const statusPath = join(root, 'status.json');
  const initialize = ". $env:NND_TEST_EVIDENCE;$ErrorActionPreference='Stop';";
  const evidence = (cliStatus, extra = '', allowRepair = false) => spawnSync(powershell, [
    '-NoProfile', '-NonInteractive', '-Command', initialize + `$nna=@{Node='node';Cli='${cliStatus.replaceAll("'", "''")}';DataRoot='${join(root, 'data').replaceAll("'", "''")}'};$status=Get-NndRegistrationStatus $nna${allowRepair ? ' -AllowInvalidForRepair' : ''};${extra}`,
  ], { encoding: 'utf8', windowsHide: true, timeout: 12000, env: { ...process.env, NND_TEST_EVIDENCE: helperPath } });

  const goodCli = join(root, 'good.mjs');
  const badCli = join(root, 'bad.mjs');
  await writeFile(goodCli, `process.stdout.write(JSON.stringify(${JSON.stringify(good)}))`);

  const accepted = evidence(goodCli, `Assert-NndUninstallRegistrationStatus $status '${join(root, 'slot').replaceAll("'", "''")}' '20261004-4';$guard=@{Frame=@{installation_id='${installationId}';data_id='${dataId}'}};Assert-NndUninstallGuardIdentity $guard @{installation_id='${installationId}';data_id='${dataId}'}`);
  const badRoot = { ...good, root: join(root, 'other') };
  await writeFile(badCli, `process.stdout.write(JSON.stringify(${JSON.stringify(badRoot)}))`);
  assert.match(evidence(badCli, `Assert-NndUninstallRegistrationStatus $status '${join(root, 'slot').replaceAll("'", "''")}' '20261004-4'`).stderr,
    /expected registered NND package/u);
  const foreign = evidence(goodCli, `$guard=@{Frame=@{installation_id='nna_${'0'.repeat(64)}';data_id='${dataId}'}};Assert-NndUninstallGuardIdentity $guard @{installation_id='${installationId}';data_id='${dataId}'}`);
  assert.match(foreign.stderr, /guard identity changed/u);
  const invalidCli = join(root, 'invalid.mjs');
  await writeFile(invalidCli, 'process.stdout.write("not-json")');
  assert.match(evidence(invalidCli).stderr, /status is unavailable/u);
  const incompleteCli = join(root, 'incomplete.mjs');
  await writeFile(incompleteCli, `process.stdout.write(JSON.stringify(${JSON.stringify({ ...good, valid: false, reason: 'nnd_package_incomplete' })}))`);
  assert.match(evidence(incompleteCli).stderr, /status is unavailable/u);
  const repair = evidence(incompleteCli, '[Console]::Out.WriteLine($status.reason)', true);
  assert.equal(repair.status, 0, repair.stderr);
  assert.match(repair.stdout, /nnd_package_incomplete/u);
  assert.match(evidence(incompleteCli,
    `Assert-NndUninstallRegistrationStatus $status '${join(root, 'slot').replaceAll("'", "''")}' '20261004-4'`, true).stderr,
  /expected registered NND package/u);
});
