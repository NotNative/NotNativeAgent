// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const load = `$tokens=$null;$errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($env:NND_TEST_INSTALLER,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Installer syntax failed'}
foreach($name in @('Assert-NndRemovalTarget','Get-InstalledNna','Remove-NndTree')){
 $node=$ast.Find({param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq $name},$true)
 Invoke-Expression $node.Extent.Text
}
$ErrorActionPreference='Stop'
`;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nnd-uninstall-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'source')); await mkdir(join(root, 'target'));
  return root;
}
function run(root, body) {
  return execFileSync(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', load + body], { windowsHide: true, encoding: 'utf8',
      env: { ...process.env, NND_TEST_INSTALLER: resolve('install.ps1'), NND_TEST_ROOT: root } });
}
test('uninstall removal refuses source overlap and junction aliases', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t);
  await symlink(join(root, 'source'), join(root, 'alias'), 'junction');
  assert.match(run(root, `
$source=Join-Path $env:NND_TEST_ROOT 'source'
$target=Join-Path $env:NND_TEST_ROOT 'target'
if((Assert-NndRemovalTarget $target $source) -ne $target){throw 'Target changed'}
foreach($bad in @($source,$env:NND_TEST_ROOT,(Join-Path $env:NND_TEST_ROOT 'alias'))){
 $rejected=$false;try{Assert-NndRemovalTarget $bad $source | Out-Null}catch{$rejected=$true}
 if(!$rejected){throw 'Unsafe removal admitted'}
}
'verified'
`), /verified/u);
});
test('uninstall selects installed custom NNA and fails closed on malformed selection', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t), install = join(root, 'target'), native = join(root, 'native'), data = join(root, 'data');
  await mkdir(join(native, 'installed', 'src'), { recursive: true }); await mkdir(data);
  await writeFile(join(native, 'installed', 'src', 'cli.js'), '');
  await writeFile(join(native, 'install.json'), JSON.stringify({ product: 'NotNativeAgent', install_root: native, data_root: data, node: process.execPath }));
  await writeFile(join(install, 'nna-service-selection.json'), JSON.stringify({ schema_version: '1.0', nna_install_root: native }));
  assert.match(run(root, `
$InstallDir=Join-Path $env:NND_TEST_ROOT 'target';$Uninstall=$true
$selected=Get-InstalledNna
if($selected.InstallRoot -ne (Join-Path $env:NND_TEST_ROOT 'native')){throw 'Wrong native selection'}
Set-Content -LiteralPath (Join-Path $InstallDir 'nna-service-selection.json') -Value '{}'
$rejected=$false;try{Get-InstalledNna | Out-Null}catch{$rejected=$true}
if(!$rejected){throw 'Malformed selection fell back'}
'verified'
`), /verified/u);
});

test('removal deletes internal pnpm junctions without touching their target', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'source', 'sentinel'), 'retained');
  await symlink(join(root, 'source'), join(root, 'target', 'pnpm-link'), 'junction');
  assert.match(run(root, `
$source=Join-Path $env:NND_TEST_ROOT 'source'
$target=Join-Path $env:NND_TEST_ROOT 'target'
Remove-NndTree $target $source
if(Test-Path -LiteralPath $target){throw 'Target remains'}
if((Get-Content -LiteralPath (Join-Path $source 'sentinel') -Raw) -ne 'retained'){throw 'Junction target changed'}
'verified'
`), /verified/u);
});
