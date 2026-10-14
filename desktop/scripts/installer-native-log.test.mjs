// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const literal = value => `'${value.replaceAll("'", "''")}'`;

test('native tool logs use application data rather than the caller directory',
  { skip: process.platform !== 'win32' }, async t => {
    const fixture = await mkdtemp(join(tmpdir(), 'nnd-native-logs-'));
    t.after(() => rm(fixture, { recursive: true, force: true }));
    const source = resolve('install.ps1');
    const script = `$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(${literal(source)}, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Desktop installer does not parse' }
foreach ($name in @('Get-NativeLogPath', 'Invoke-Native', 'Show-NativeFailures')) {
  $fn = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
  if (!$fn) { throw "Missing function $name" }
  Invoke-Expression $fn.Extent.Text
}
$result = Invoke-Native 'cmd.exe' @('/c', 'echo native-output') 'native-error.log' 'native-out.log'
if ($result -ne 0) { throw "Native command exited $result" }
Show-NativeFailures 'native-out.log' 1
`;
    const run = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { cwd: fixture, encoding: 'utf8', timeout: 30000, windowsHide: true,
        env: { ...process.env, APPDATA: join(fixture, 'appdata') } });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const log = join(fixture, 'appdata', 'NotNativeDesktop', 'installer-logs', 'native-out.log');
    assert.match((await readFile(log)).toString('utf16le'), /native-output/u);
    assert.equal(await stat(join(fixture, 'native-out.log')).then(() => true, () => false), false);
  });
