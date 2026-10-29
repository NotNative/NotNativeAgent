// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const literal = value => `'${value.replaceAll("'", "''")}'`;

test('desktop choice prompts during interactive update even when unrelated setup is skipped',
  { skip: process.platform !== 'win32' }, () => {
    const script = `$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(${literal(resolve('install.ps1'))}, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Root installer does not parse' }
$fn = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Confirm-DesktopInstallation' }, $true)
if (!$fn) { throw 'Desktop prompt function is missing' }
Invoke-Expression $fn.Extent.Text
$SkipProviderSetup = $true
$SkipWebSearchSetup = $true
$SkipPlaywrightSetup = $true
$script:answers = @('Yes', 'No')
$script:prompts = 0
function Read-Host { param($Prompt) $script:prompts++; return $script:answers[$script:prompts - 1] }
if (!(Confirm-DesktopInstallation $false $false)) { throw 'Yes was ignored' }
if (Confirm-DesktopInstallation $false $false) { throw 'No was ignored' }
if (Confirm-DesktopInstallation $false $true) { throw 'Redirected input was accepted' }
if (!(Confirm-DesktopInstallation $true $true)) { throw 'Explicit desktop request was ignored' }
if ($script:prompts -ne 2) { throw 'Prompt count was incorrect' }
`;
    const run = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout: 30000, windowsHide: true });
    assert.equal(run.status, 0, run.stdout + run.stderr);
  });

test('desktop installer allocates a fresh log for every upgrade',
  { skip: process.platform !== 'win32' }, () => {
    const script = `$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(${literal(resolve('install.ps1'))}, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Root installer does not parse' }
$fn = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'New-DesktopInstallLogPath' }, $true)
if (!$fn) { throw 'Desktop log allocator is missing' }
Invoke-Expression $fn.Extent.Text
$first = New-DesktopInstallLogPath 'C:\\NNA data'
$second = New-DesktopInstallLogPath 'C:\\NNA data'
if ($first -eq $second -or $first -notmatch 'nna-desktop-install-[0-9a-f]{32}\\.log$' -or
    $second -notmatch 'nna-desktop-install-[0-9a-f]{32}\\.log$') { throw 'Desktop logs are reused' }
`;
    const run = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout: 30000, windowsHide: true });
    assert.equal(run.status, 0, run.stdout + run.stderr);
  });

test('desktop handoff creates its log and preserves custom NNA and desktop roots',
  { skip: process.platform !== 'win32' }, async t => {
    const fixture = await mkdtemp(join(tmpdir(), 'nna-desktop-handoff-'));
    t.after(() => rm(fixture, { recursive: true, force: true }));
    const installRoot = join(fixture, 'custom NNA install');
    const dataRoot = join(fixture, 'custom NNA data');
    const desktopRoot = join(fixture, 'custom desktop install');
    const log = join(dataRoot, 'logs', 'nna-desktop-install-new.log');
    const priorLog = join(dataRoot, 'logs', 'nna-desktop-install.log');
    const fakeInstaller = join(fixture, 'desktop.cmd');
    const fakeNpm = join(fixture, 'npm.cmd');
    const bootstrapMarker = join(fixture, 'pnpm-bootstrap-ran');
    const target = join(installRoot, 'installed');
    await mkdir(installRoot);
    await mkdir(desktopRoot);
    await mkdir(join(dataRoot, 'logs'), { recursive: true });
    await writeFile(priorLog, 'prior install output\n');
    await writeFile(join(desktopRoot, 'VERSION'), '20261014-9\n');
    await mkdir(join(target, 'src'), { recursive: true });
    await writeFile(join(target, 'src', 'cli.js'),
      'console.log(JSON.stringify({registered:true,valid:true,root:process.env.DESKTOP_EXPECTED_ROOT,version:"20261014-9"}));\n');
    await writeFile(fakeInstaller, '@echo off\r\necho Existing desktop 20261014-9 service is running; stopping it for the in-place replacement.\r\necho Copying source\r\necho   source copied\r\necho Building shell artifacts\r\necho   build green\r\necho Starting previously running desktop service\r\necho   Previously running desktop service restarted\r\necho desktop installed\r\necho %1^|%2^|%3^|%4^|%5^|%6\r\nexit /b 0\r\n');
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
$Version = '20261014-9'
$priorPath = $env:PATH
$priorLogHandle = [IO.File]::Open(${literal(priorLog)}, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try { $result = Invoke-DesktopInstaller } finally { $priorLogHandle.Dispose() }
if ($result -ne 0) { throw "Desktop installer returned $result; log: $(Get-Content -LiteralPath $DesktopInstallLog -Raw)" }
if ($env:PATH -cne $priorPath) { throw 'Desktop handoff did not restore PATH' }
`;
    const run = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout: 30000, windowsHide: true,
        env: { ...process.env, DESKTOP_EXPECTED_ROOT: desktopRoot } });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /Service running - stopping service[\s\S]*New desktop files copied[\s\S]*Desktop build ready[\s\S]*Service ready on updated package/u);
    assert.match(await readFile(bootstrapMarker, 'utf8'), /bootstrapped/u);
    const output = await readFile(log, 'utf8');
    assert.match(output,
      /-NnaInstallRoot\|.*custom NNA install"?\|-NnaDataRoot\|.*custom NNA data"?\|-InstallDir\|.*custom desktop install/u);
  });

test('desktop handoff rejects a successful installer that leaves a stale package version',
  { skip: process.platform !== 'win32' }, async t => {
    const fixture = await mkdtemp(join(tmpdir(), 'nna-desktop-stale-'));
    t.after(() => rm(fixture, { recursive: true, force: true }));
    const target = join(fixture, 'installed');
    const desktopRoot = join(fixture, 'desktop');
    const log = join(fixture, 'data', 'logs', 'nna-desktop-install.log');
    const fakeInstaller = join(fixture, 'desktop.cmd');
    await mkdir(join(target, 'src'), { recursive: true });
    await mkdir(desktopRoot);
    await writeFile(join(desktopRoot, 'VERSION'), '20261014-8\n');
    await writeFile(join(target, 'src', 'cli.js'),
      'console.log(JSON.stringify({registered:true,valid:true,root:process.env.DESKTOP_EXPECTED_ROOT,version:"20261014-8"}));\n');
    await writeFile(fakeInstaller, '@echo off\r\nexit /b 0\r\n');
    const script = `$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(${literal(resolve('install.ps1'))}, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Root installer does not parse' }
$fn = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-DesktopInstaller' }, $true)
Invoke-Expression $fn.Extent.Text
function Get-Command { param($Name) if ($Name -eq 'pnpm') { return 'pnpm' }; throw 'Unexpected command probe' }
$DesktopScript = ${literal(fakeInstaller)}
$DesktopInstallLog = ${literal(log)}
$InstallRoot = ${literal(fixture)}
$DataRoot = ${literal(join(fixture, 'data'))}
$NodePath = ${literal(process.execPath)}
$Target = ${literal(target)}
$DesktopRegistered = $false
$Version = '20261014-9'
if ((Invoke-DesktopInstaller) -ne 1) { throw "Stale desktop package was accepted; log: $(Get-Content -LiteralPath $DesktopInstallLog -Raw)" }
`;
    const run = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout: 30000, windowsHide: true,
        env: { ...process.env, DESKTOP_EXPECTED_ROOT: desktopRoot } });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(await readFile(log.replace(/\.log$/u, '.handoff.log'), 'utf8'), /did not register the expected version/u);
  });

test('desktop handoff finishes when a restarted child retains the install log handle',
  { skip: process.platform !== 'win32' }, async t => {
    const fixture = await mkdtemp(join(tmpdir(), 'nna-desktop-handle-'));
    t.after(async () => {
      await new Promise(resolve => setTimeout(resolve, 3200));
      await rm(fixture, { recursive: true, force: true });
    });
    const target = join(fixture, 'installed');
    const desktopRoot = join(fixture, 'desktop');
    const log = join(fixture, 'data', 'logs', 'nna-desktop-install.log');
    const fakeInstaller = join(fixture, 'desktop.cmd');
    const completionMarker = join(fixture, 'completed-at.txt');
    await mkdir(join(target, 'src'), { recursive: true });
    await mkdir(desktopRoot);
    await writeFile(join(desktopRoot, 'VERSION'), '20261014-9\n');
    await writeFile(join(target, 'src', 'cli.js'),
      'console.log(JSON.stringify({registered:true,valid:true,root:process.env.DESKTOP_EXPECTED_ROOT,version:"20261014-9"}));\n');
    await writeFile(fakeInstaller, `@echo off\r\necho desktop installed\r\nstart "" /b "${process.execPath}" -e "setTimeout(() => {}, 3000)"\r\nexit /b 0\r\n`);
    const script = `$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(${literal(resolve('install.ps1'))}, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Root installer does not parse' }
$fn = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-DesktopInstaller' }, $true)
Invoke-Expression $fn.Extent.Text
function Get-Command { param($Name) if ($Name -eq 'pnpm') { return 'pnpm' }; throw 'Unexpected command probe' }
$DesktopScript = ${literal(fakeInstaller)}
$DesktopInstallLog = ${literal(log)}
$InstallRoot = ${literal(fixture)}
$DataRoot = ${literal(join(fixture, 'data'))}
$NodePath = ${literal(process.execPath)}
$Target = ${literal(target)}
$DesktopRegistered = $false
$Version = '20261014-9'
if ((Invoke-DesktopInstaller) -ne 0) { throw 'Desktop installer did not finish' }
[IO.File]::WriteAllText(${literal(completionMarker)}, [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString())
`;
    const started = Date.now();
    const run = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout: 6000, windowsHide: true,
        env: { ...process.env, DESKTOP_EXPECTED_ROOT: desktopRoot } });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const completedAt = Number(await readFile(completionMarker, 'utf8'));
    assert.ok(completedAt - started < 2500, 'handoff waited for the background child to close the log');
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
    assert.match(await readFile(log.replace(/\.log$/u, '.handoff.log'), 'utf8'), /registered desktop package root is invalid/u);
  });
