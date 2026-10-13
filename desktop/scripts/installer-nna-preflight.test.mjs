// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const version = '20261002-1';
const fakeCli = `const root = process.argv[5];
const { createHash } = require('node:crypto');
const { realpathSync } = require('node:fs');
if (process.env.NND_PREFLIGHT_MODE === 'missing') process.exit(3);
if (process.env.NND_PREFLIGHT_MODE === 'malformed') { process.stdout.write('{bad'); process.exit(0); }
if (process.env.NND_PREFLIGHT_MODE === 'oversized') { process.stdout.write('x'.repeat(10000)); process.exit(0); }
if (process.env.NND_PREFLIGHT_MODE === 'hung') { setTimeout(() => {}, 30000); return; }
const hash = (value) => createHash('sha256').update(realpathSync(value).toLowerCase()).digest('hex');
const record = { protocol: '1.0', installation_id: 'nna_' + hash(root), data_id: 'data_' + hash(process.env.NNA_HOME),
  native_version: '${version}', capabilities: ['service_supervision', 'setup_control_plane', 'atomic_ui_attach', 'installer_guard'],
  commands: ['start', 'status', 'stop', 'attach', 'install-guard'] };
if (process.env.NND_PREFLIGHT_MODE === 'incompatible') record.capabilities.pop();
if (process.env.NND_PREFLIGHT_MODE === 'wrong-version') record.native_version = '20260101-1';
if (process.env.NND_PREFLIGHT_MODE === 'warning') process.stderr.write('ExperimentalWarning: harmless runtime warning\\n');
process.stdout.write(JSON.stringify(record));`;

test('NNA preflight selects the specified root and rejects absent, malformed, and incompatible native capabilities before installer mutation',
  { skip: process.platform !== 'win32' }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'nnd-nna-preflight-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const roots = [join(root, 'NNA A'), join(root, 'NNA B')];
    const selected = [];
    for (const install of roots) {
      const data = join(install, 'data');
      await mkdir(data, { recursive: true });
      const cli = join(install, 'cli.cjs');
      await writeFile(cli, fakeCli);
      selected.push({ Node: process.execPath, Cli: cli, InstallRoot: install, DataRoot: data, Version: version });
    }
    const helper = resolve('scripts/installer-nna-preflight.ps1').replaceAll("'", "''");
    const guard = resolve('scripts/installer-native-guard.ps1').replaceAll("'", "''");
    const script = `$ErrorActionPreference='Stop'; . '${guard}'; . '${helper}';
$selected=$env:NND_TEST_SELECTED|ConvertFrom-Json
try { $result=Assert-NndNnaCapabilities $selected; [Console]::Out.WriteLine('OK '+$result.installation_id); exit 0 }
catch { [Console]::Error.WriteLine($_.Exception.Message); exit 12 }`;
    function probe(choice, mode) {
      return spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', windowsHide: true, timeout: 16000,
        env: { ...process.env, Path: '', NND_TEST_SELECTED: JSON.stringify(choice), NND_PREFLIGHT_MODE: mode },
      });
    }
    const first = probe(selected[0], 'valid');
    const second = probe(selected[1], 'valid');
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.match(first.stdout, /^OK nna_[a-f0-9]{64}/u);
    assert.match(second.stdout, /^OK nna_[a-f0-9]{64}/u);
    assert.notEqual(first.stdout.trim(), second.stdout.trim(), 'The selected NNA root must determine identity');
    assert.equal(probe(selected[0], 'warning').status, 0, 'Non-fatal Node stderr warnings must not reject a valid capability response');
    for (const mode of ['missing', 'malformed', 'oversized', 'incompatible', 'wrong-version']) {
      const result = probe(selected[1], mode);
      assert.equal(result.status, 12, `${mode}: ${result.stderr}`);
      assert.match(result.stderr, /Selected NNA (?:cannot provide|lacks required)/u, mode);
    }
    const hung = probe(selected[1], 'hung');
    assert.equal(hung.status, 12, `Hanging native command must be stopped: ${hung.stderr}`);
    assert.match(hung.stderr, /cannot provide bounded native NND capabilities/u);
    assert.deepEqual(await readFile(selected[1].Cli, 'utf8'), fakeCli, 'Preflight must not mutate the selected NNA');
    const installer = await readFile(resolve('install.ps1'), 'utf8');
    assert.equal(installer.indexOf('Assert-NndNnaCapabilities $nna')
      < installer.indexOf("Invoke-NndRegistration 'status' $targetPath"), true);
    const pinnedRegistration = `$ErrorActionPreference='Stop';
$tokens=$null; $errors=$null;
$ast=[Management.Automation.Language.Parser]::ParseFile('${resolve('install.ps1').replaceAll("'", "''")}',[ref]$tokens,[ref]$errors);
$fn=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-NndRegistration'},$true);
Invoke-Expression $fn.Extent.Text;
function Get-InstalledNna { throw 'The installation selection was re-read' }
$selected=$env:NND_TEST_SELECTED|ConvertFrom-Json;
try { Invoke-NndRegistration 'activate' $selected.InstallRoot $selected; [Console]::Out.WriteLine('PINNED'); exit 0 }
catch { [Console]::Error.WriteLine($_.Exception.Message); exit 12 }`;
    const pinned = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', pinnedRegistration], {
      encoding: 'utf8', windowsHide: true, timeout: 16000,
      env: { ...process.env, Path: '', NND_TEST_SELECTED: JSON.stringify(selected[0]), NND_PREFLIGHT_MODE: 'valid' },
    });
    assert.equal(pinned.status, 0, pinned.stderr);
    assert.match(pinned.stdout, /PINNED/u);
  });
