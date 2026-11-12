// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const literal = (value) => `'${value.replaceAll("'", "''")}'`;
const actualMajor = Number(process.versions.node.split('.')[0]);
const staleMajor = actualMajor > 24 ? actualMajor - 1 : actualMajor + 1;

function descriptorFor(root, data, overrides = {}) {
  return { product: 'NotNativeAgent', version: '20260101-1', install_root: root, data_root: data,
    node: process.execPath, node_major: actualMajor, incarnation_id: '0f8f9f6e-1a2b-4c3d-9e5f-6a7b8c9d0e1f', ...overrides };
}

async function seed(root, data, value = descriptorFor(root, data)) {
  await mkdir(root, { recursive: true });
  await mkdir(data, { recursive: true });
  const path = join(root, 'install.json');
  if (value === null) { await rm(path, { force: true }); return path; }
  await writeFile(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

test('installer refreshes only a stale runtime pin of its own installation before payload replacement', {
  skip: process.platform !== 'win32', timeout: 60_000,
}, async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), 'nna-runtime-pin-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const cases = [];
  const add = async (name, value, expectedChanged) => {
    const root = join(fixture, name, 'app');
    const data = join(fixture, name, 'data');
    const path = await seed(root, data, typeof value === 'function' ? value(root, data) : value);
    cases.push({ name, root, data, major: actualMajor, expectedChanged, path,
      before: await readFile(path, 'utf8').catch(() => null) });
  };
  await add('stale-major', (root, data) => descriptorFor(root, data, { node_major: staleMajor }), true);
  await add('stale-runtime-path', (root, data) => descriptorFor(root, data, { node: 'C:\\Other\\node.exe' }), true);
  await add('current', (root, data) => descriptorFor(root, data), false);
  await add('foreign-product', (root, data) => descriptorFor(root, data, { product: 'Other', node_major: staleMajor }), false);
  await add('other-data-root', (root, data) => descriptorFor(join(fixture, 'elsewhere'), data, { node_major: staleMajor }), false);
  await add('malformed', () => '{', false);
  await add('missing', () => null, false);

  const casesPath = join(fixture, 'cases.json');
  await writeFile(casesPath, JSON.stringify(cases.map(({ name, root, data, major }) => ({ name, root, data, major, node: process.execPath }))));
  const script = `$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(${literal(resolve('install.ps1'))}, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Root installer does not parse' }
$fn = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Sync-ExistingRuntimePin' }, $true)
if (!$fn) { throw 'Runtime pin synchronizer is missing' }
Invoke-Expression $fn.Extent.Text
$Product = 'NotNativeAgent'
function Write-InstallerStep { param($Text) }
foreach ($case in (Get-Content -LiteralPath ${literal(casesPath)} -Raw -Encoding UTF8 | ConvertFrom-Json)) {
    $changed = Sync-ExistingRuntimePin $case.node ([int]$case.major) $case.root $case.data
    [pscustomobject]@{ name = $case.name; changed = [bool]$changed } | ConvertTo-Json -Compress
}
`;
  const run = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', timeout: 45_000, windowsHide: true });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const changed = new Map(run.stdout.trim().split(/\r?\n/u).filter(Boolean)
    .map((line) => { const item = JSON.parse(line); return [item.name, item.changed]; }));
  for (const item of cases) {
    assert.equal(changed.get(item.name), item.expectedChanged, `${item.name} refresh decision`);
    const after = await readFile(item.path, 'utf8').catch(() => null);
    if (!item.expectedChanged) { assert.equal(after, item.before, `${item.name} must not rewrite the descriptor`); continue; }
    const value = JSON.parse(after);
    assert.equal(value.node, process.execPath, `${item.name} runtime path`);
    assert.equal(value.node_major, actualMajor, `${item.name} runtime major`);
    assert.equal(value.product, 'NotNativeAgent');
    assert.equal(value.version, '20260101-1');
    assert.equal(value.data_root, item.data);
    assert.equal(value.incarnation_id, '0f8f9f6e-1a2b-4c3d-9e5f-6a7b8c9d0e1f');
  }
});

test('installer refreshes the runtime pin before it replaces the payload', async () => {
  const source = await readFile('install.ps1', 'utf8');
  const sync = source.indexOf('Sync-ExistingRuntimePin $NodePath $NodeMajor $InstallRoot $DataRoot');
  const remove = source.indexOf('Remove-Item -LiteralPath $Target -Recurse -Force');
  assert.ok(sync > 0, 'the payload replacement must refresh a stale runtime pin');
  assert.ok(sync < remove, 'the pin is refreshed before removal');
});
