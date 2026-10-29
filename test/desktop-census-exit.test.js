// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DESKTOP_CENSUS_NATIVE_TYPES, scanDesktopLegacyOwners } from '../src/desktop-legacy-census.js';
import { runPrivateWindowsProgram } from '../src/desktop-service-private-windows.js';

test('census native proof rejects stale live identity and distinguishes terminated and invalid PIDs', { skip: process.platform !== 'win32' }, async () => {
  const child = spawn(process.execPath, ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = once(child, 'exit');
  const probe = async () => runPrivateWindowsProgram(`$ErrorActionPreference='Stop'\n${DESKTOP_CENSUS_NATIVE_TYPES}
    $r=[Console]::In.ReadToEnd()|ConvertFrom-Json
    $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$r.pid)
    $created=0; if($null -ne $p.CreationDate) { $created=$p.CreationDate.ToUniversalTime().ToFileTimeUtc() }
    [Console]::Out.WriteLine((@{child=[DesktopArgv]::Probe([int]$r.pid,[long]$created);
      stale=[DesktopArgv]::Probe([int]$r.pid,[long]($created-10000000));
      missing=[DesktopArgv]::Probe([int]$r.pid,0);invalid=[DesktopArgv]::Probe(0,0)}|ConvertTo-Json -Compress))`, { pid: child.pid });
  try {
    await once(child.stdout, 'data');
    assert.deepEqual(await probe(), { child: 'same', stale: 'unknown', missing: 'unknown', invalid: 'unknown' });
    child.kill(); await exited;
    assert.deepEqual(await probe(), { child: 'exited', stale: 'exited', missing: 'exited', invalid: 'unknown' });
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; } }
});

test('benign short-lived Node processes cannot become false legacy owners in stale WMI snapshots', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const churn = (async () => {
    for (let wave = 0; wave < 32; wave += 1) {
      await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' });
        child.once('error', reject); child.once('exit', resolve);
      })));
    }
  })();
  try {
    for (let index = 0; index < 6; index += 1) {
      assert.equal((await scanDesktopLegacyOwners({ node: process.execPath })).unknown, 0);
    }
  } finally { await churn; }
});
