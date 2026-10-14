// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const literal = value => `'${value.replaceAll("'", "''")}'`;

test('desktop handoff creates its log and preserves custom NNA and NND roots',
  { skip: process.platform !== 'win32' }, async t => {
    const fixture = await mkdtemp(join(tmpdir(), 'nna-desktop-handoff-'));
    t.after(() => rm(fixture, { recursive: true, force: true }));
    const installRoot = join(fixture, 'custom NNA install');
    const dataRoot = join(fixture, 'custom NNA data');
    const desktopRoot = join(fixture, 'custom NND install');
    const log = join(dataRoot, 'logs', 'nna-desktop-install.log');
    const fakeInstaller = join(fixture, 'desktop.cmd');
    const fakeNpm = join(fixture, 'npm.cmd');
    const bootstrapMarker = join(fixture, 'pnpm-bootstrap-ran');
    const target = join(installRoot, 'installed');
    await mkdir(installRoot);
    await mkdir(join(target, 'src'), { recursive: true });
    await writeFile(join(target, 'src', 'cli.js'),
      'console.log(JSON.stringify({registered:true,root:process.env.NND_EXPECTED_ROOT}));\n');
    await writeFile(fakeInstaller, '@echo off\r\necho %1^|%2^|%3^|%4^|%5^|%6\r\nexit /b 0\r\n');
    await writeFile(fakeNpm, `@echo off\r\necho bootstrapped > "${bootstrapMarker}"\r\nexit /b 0\r\n`);
    const script = `$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(${literal(resolve('install.ps1'))}, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Root installer does not parse' }
$fn = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-DesktopInstaller' }, $true)
if (!$fn) { throw 'Desktop handoff function is missing' }
Invoke-Expression $fn.Extent.Text
function Get-Command { param($Name) if ($Name -eq 'pnpm') { return $null }; throw 'Unexpected command probe' }
function Find-CompatibleNpm { param($Node) return ${literal(fakeNpm)} }
$DesktopScript = ${literal(fakeInstaller)}
$DesktopInstallLog = ${literal(log)}
$InstallRoot = ${literal(installRoot)}
$DataRoot = ${literal(dataRoot)}
$NodePath = ${literal(process.execPath)}
$Target = ${literal(target)}
$DesktopRegistered = $true
$priorPath = $env:PATH
$result = Invoke-DesktopInstaller
if ($result -ne 0) { throw "Desktop installer returned $result" }
if ($env:PATH -cne $priorPath) { throw 'Desktop handoff did not restore PATH' }
`;
    const run = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout: 30000, windowsHide: true,
        env: { ...process.env, NND_EXPECTED_ROOT: desktopRoot } });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.match(await readFile(bootstrapMarker, 'utf8'), /bootstrapped/u);
    const output = (await readFile(log)).toString('utf16le');
    assert.match(output,
      /-NnaInstallRoot\|.*custom NNA install"?\|-NnaDataRoot\|.*custom NNA data"?\|-InstallDir\|.*custom NND install/u);
  });

test('desktop handoff refuses a malformed registered root before invoking the installer',
  { skip: process.platform !== 'win32' }, async t => {
    const fixture = await mkdtemp(join(tmpdir(), 'nna-desktop-invalid-'));
    t.after(() => rm(fixture, { recursive: true, force: true }));
    const target = join(fixture, 'installed');
    const log = join(fixture, 'data', 'logs', 'nna-desktop-install.log');
    const marker = join(fixture, 'invoked');
    const fakeInstaller = join(fixture, 'desktop.cmd');
    await mkdir(join(target, 'src'), { recursive: true });
    await writeFile(join(target, 'src', 'cli.js'),
      'console.log(JSON.stringify({registered:true,root:"relative-path"}));\n');
    await writeFile(fakeInstaller, `@echo off\r\necho invoked > "${marker}"\r\nexit /b 0\r\n`);
    const script = `$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(${literal(resolve('install.ps1'))}, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Root installer does not parse' }
$fn = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-DesktopInstaller' }, $true)
Invoke-Expression $fn.Extent.Text
$DesktopScript = ${literal(fakeInstaller)}
$DesktopInstallLog = ${literal(log)}
$InstallRoot = ${literal(fixture)}
$DataRoot = ${literal(join(fixture, 'data'))}
$NodePath = ${literal(process.execPath)}
$Target = ${literal(target)}
$DesktopRegistered = $true
if ((Invoke-DesktopInstaller) -ne 1) { throw 'Malformed root was accepted' }
if (Test-Path -LiteralPath ${literal(marker)}) { throw 'Desktop installer was invoked' }
`;
    const run = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout: 30000, windowsHide: true });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.match((await readFile(log)).toString('utf8'), /registered desktop package root is invalid/u);
  });
