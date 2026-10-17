// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { opencodePublicStatus } from '../src/opencode/config.js';

const cases = [
  { enabled: false, running: false }, { enabled: false, running: true },
  { enabled: true, running: false }, { enabled: true, running: true },
  { enabled: true, running: true, failure: 'login' },
  { enabled: false, running: false, failure: 'unknown' },
];
for (const scenario of cases) test(`installer preserves OpenCode state ${JSON.stringify(scenario)}`, { skip: process.platform !== 'win32' }, async () => {
  const source = await readFile('install.ps1', 'utf8');
  const start = source.indexOf("Write-InstallerSection 'OpenCode service'");
  const section = source.slice(start, source.indexOf('if (-not $SkipPathUpdate)', start));
  const status = { service: { ...opencodePublicStatus({ enabled: scenario.enabled, hostname: '127.0.0.1', port: 4095,
    username: 'opencode', password: 'fixture-password-123456' }, {}) }, runtime: { running: false } };
  if (scenario.failure === 'unknown') delete status.service.autostart_enabled;
  const script = String.raw`$ErrorActionPreference = 'Stop'
$DataRoot = 'C:\fixture'; $env:NNA_HOME = 'original-home'; $OpencodeStoppedForUpgrade = $${scenario.running}
$script:calls = @(); $script:failed = $false
$script:status = '${JSON.stringify(status)}'
function Write-InstallerSection { param($Text) }
function Write-InstallerStep { param($Text) }
function Write-InstallerSkip { param($Text) }
function Write-InstallerOk { param($Text) }
function Write-InstallerWarning { param($Text) }
function Invoke-OpencodeInstallerAction([string[]]$Arguments) {
  $script:calls += $Arguments[0]
  if ($Arguments[0] -eq 'status') { return $script:status }
  if ('${scenario.failure}' -eq 'login' -and $Arguments[0] -eq 'enable') { throw 'fixture login failure' }
  return '{}'
}
try { ${section} } catch { $script:failed = $true }
if ($env:NNA_HOME -cne 'original-home') { throw 'Environment was not restored' }
@{ failed=$script:failed; calls=@($script:calls) } | ConvertTo-Json -Compress
`;
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.failed, Boolean(scenario.failure));
  const expected = ['status'];
  if (scenario.enabled && scenario.failure !== 'unknown') expected.push('enable');
  if (scenario.running && !scenario.failure) expected.push('start');
  assert.deepEqual(result.calls, expected);
});
