// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

for (const mode of ['running', 'stopped', 'unknown', 'stop-failed', 'wait-failed', 'start-wrong-version', 'starting', 'setup-required', 'stopped-lock-held']) {
  test(`root payload lifecycle handles ${mode} without changing login state`, { skip: process.platform !== 'win32' }, () => {
    const script = String.raw`$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile('${resolve('install.ps1').replaceAll("'", "''")}', [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Installer parse failed' }
foreach ($name in @('Stop-DesktopBeforePayloadReplacement', 'Restore-DesktopAfterPayloadReplacement')) {
  $fn = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
  Invoke-Expression $fn.Extent.Text
}
$SourceRoot = 'C:\source'; $script:calls = @(); $env:NNA_HOME = 'prior-home'
function Test-Path { param($LiteralPath, $PathType) return $true }
function Write-InstallerStep { param($Text) }
function Write-InstallerOk { param($Text) }
function NodeFixture {
  $global:LASTEXITCODE = 0; $call = $args -join '|'; $script:calls += $call
  if ($call -match 'desktop\|status$') {
    if ('${mode}' -eq 'unknown') { return '{}' }
    return (@{running=('${mode}' -notin @('stopped', 'stopped-lock-held'))} | ConvertTo-Json -Compress)
  }
  if ($call -match '\|stop\|') { if ('${mode}' -eq 'stop-failed') { $global:LASTEXITCODE=1 }; return '{}' }
  if ($call -match 'installer-wait-stopped') { if ('${mode}' -in @('wait-failed', 'stopped-lock-held')) { $global:LASTEXITCODE=1 }; return '{}' }
  if ($call -match '\|start\|') { return (@{service_state=$(if ('${mode}' -eq 'starting') {'starting'} elseif ('${mode}' -eq 'setup-required') {'setup_required'} else {'ready'});package_version=$(if ('${mode}' -eq 'start-wrong-version') {'old'} else {'20260101-2'})} | ConvertTo-Json -Compress) }
  if ($call -match 'desktop\|service\|status\|') { if ('${mode}' -eq 'start-wrong-version') { return '{"service_state":"failed","package_version":"old"}' }; return '{"service_state":"ready","package_version":"20260101-2"}' }
  throw 'Unexpected lifecycle command'
}
$failed = $false
try {
  $running = Stop-DesktopBeforePayloadReplacement 'NodeFixture' 'C:\install' 'C:\data'
  if ($running) { Restore-DesktopAfterPayloadReplacement 'NodeFixture' 'C:\install' 'C:\data' '20260101-2' }
} catch { $failed = $true }
if ($env:NNA_HOME -cne 'prior-home') { throw 'Data root was not restored' }
if ($script:calls -match '\|(enable|disable)($|\|)') { throw 'Login preference was changed' }
$expectedFailure = '${mode}' -in @('unknown', 'stop-failed', 'wait-failed', 'start-wrong-version', 'stopped-lock-held')
if ($failed -ne $expectedFailure) { throw 'Wrong lifecycle outcome' }
if ('${mode}' -eq 'running' -and ($script:calls.Count -ne 4 -or $script:calls[2] -notmatch 'installer-wait-stopped')) { throw 'Stop was not verified before restart' }
if ('${mode}' -eq 'stopped' -and $script:calls.Count -ne 2) { throw 'Stopped service was started' }
if ('${mode}' -in @('unknown', 'stop-failed', 'wait-failed', 'stopped-lock-held') -and $script:calls -match '\|start\|') { throw 'Unverified shutdown was restarted' }
`;
    const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.equal(run.status, 0, run.stdout + run.stderr);
  });
}
test('root installer drains desktop before removing NNA files and restores only its observed running state', async () => {
  const source = await readFile('install.ps1', 'utf8');
  const stop = source.indexOf('$DesktopStoppedForUpgrade = Stop-DesktopBeforePayloadReplacement');
  const remove = source.indexOf('Remove-Item -LiteralPath $Target -Recurse -Force');
  assert.ok(stop > 0 && stop < remove);
  assert.match(source, /if \(\$DesktopStoppedForUpgrade\) \{ Restore-DesktopAfterPayloadReplacement/u);
});
