// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const installer = resolve('install.ps1').replaceAll("'", "''");
const script = `$ErrorActionPreference='Stop';
$tokens=$null; $errors=$null;
$ast=[Management.Automation.Language.Parser]::ParseFile('${installer}',[ref]$tokens,[ref]$errors);
if($errors.Count){ throw 'Installer PowerShell source does not parse' }
$fn=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-InstalledNna'},$true);
Invoke-Expression $fn.Extent.Text;
$InstallDir=$env:NND_TEST_INSTALL; $NnaInstallRoot=$env:NND_TEST_EXPLICIT_ROOT; $Uninstall=$env:NND_TEST_UNINSTALL -eq '1';
try { $selected=Get-InstalledNna; [Console]::Out.WriteLine('OK '+$selected.InstallRoot); exit 0 }
catch { [Console]::Error.WriteLine($_.Exception.Message); exit 12 }`;

test('installer reuses pinned and legacy NNA selections for upgrade and uninstall',
  { skip: process.platform !== 'win32' }, async t => {
    const base = await mkdtemp(join(tmpdir(), 'nnd-selection-pin-'));
    t.after(() => rm(base, { recursive: true, force: true }));
    const nnd = join(base, 'NND'), nna = join(base, 'NNA'), data = join(base, 'data');
    await mkdir(nnd); await mkdir(join(nna, 'installed', 'src'), { recursive: true }); await mkdir(data);
    const node = join(nna, 'node.exe'), cli = join(nna, 'installed', 'src', 'cli.js');
    await writeFile(node, 'fixture'); await writeFile(cli, 'fixture');
    await writeFile(join(nna, 'install.json'), JSON.stringify({ product: 'NotNativeAgent',
      version: '20261003-1', node, install_root: nna, data_root: data }));
    const file = join(nnd, 'nna-service-selection.json');
    const baseSelection = { schema_version: '1.0', nna_install_root: nna };
    function select(uninstall = false, explicitRoot = '') {
      return spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, Path: '', NND_TEST_INSTALL: nnd, NND_TEST_UNINSTALL: uninstall ? '1' : '0',
          NND_TEST_EXPLICIT_ROOT: explicitRoot },
      });
    }
    for (const selection of [baseSelection, { ...baseSelection,
      installation_id: `nna_${'a'.repeat(64)}`, data_id: `data_${'b'.repeat(64)}` }]) {
      await writeFile(file, JSON.stringify(selection));
      for (const uninstall of [false, true]) {
        const result = select(uninstall);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim(), `OK ${nna}`);
      }
      assert.equal(select(false, nna).status, 0, 'The explicit selected root remains valid');
      const conflict = select(false, join(base, 'other NNA'));
      assert.equal(conflict.status, 12, conflict.stderr);
      assert.match(conflict.stderr, /conflicts with the installed NND selection/u);
    }
    for (const selection of [{ ...baseSelection, installation_id: 'wrong', data_id: `data_${'b'.repeat(64)}` },
      { ...baseSelection, installation_id: `nna_${'a'.repeat(64)}`, data_id: `data_${'b'.repeat(64)}`, extra: true }]) {
      await writeFile(file, JSON.stringify(selection));
      const result = select();
      assert.equal(result.status, 12, result.stderr);
      assert.match(result.stderr, /Installed NNA selection is invalid/u);
    }
  });
