// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const version = '20261003-9';

/** Fake NNA CLI: capabilities + a registered previous package whose service
 *  is stopped. package deactivate/activate are recorded and fail on demand
 *  so the suite can inject failures at exact transaction stages. */
const fakeCli = activationMode => `const { createHash } = require('node:crypto');
const { realpathSync, appendFileSync } = require('node:fs');
const hash = value => createHash('sha256').update(realpathSync(value).toLowerCase()).digest('hex');
appendFileSync(process.env.NND_TXN_LOG, process.argv.slice(3).join(' ') + '\\n');
const root = process.argv[5];
if (process.argv[4] === 'capabilities') {
  process.stdout.write(JSON.stringify({ protocol: '1.0', installation_id: 'nna_' + hash(root),
    data_id: 'data_' + hash(process.env.NNA_HOME), native_version: '${version}',
    capabilities: ['service_supervision', 'setup_control_plane', 'atomic_ui_attach', 'installer_guard'],
    commands: ['start', 'status', 'stop', 'attach', 'install-guard'] }));
} else if (process.argv[3] === 'package' && process.argv[4] === 'status') {
  process.stdout.write(JSON.stringify({ registered: true, valid: true, root: process.env.NND_TXN_TARGET, version: '20261003-5' }));
} else if (process.argv[3] === 'service') {
  if (process.argv[4] === 'status') process.exit(3);
  process.exit(0);
} else if (process.argv[3] === 'package' && process.argv[4] === 'deactivate') {
  process.exit(0);
} else if (process.argv[3] === 'package' && process.argv[4] === 'activate') {
  process.exit(${activationMode ? 0 : 7});
} else process.exit(6);`;

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'nnd-transaction-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const target = join(base, 'NND existing');
  const native = join(base, 'NNA selected'), data = join(base, 'NNA data');
  const appdata = join(base, 'appdata');
  await mkdir(target); await mkdir(data); await mkdir(appdata);
  await mkdir(join(native, 'installed', 'src'), { recursive: true });
  await writeFile(join(native, 'install.json'), JSON.stringify({ product: 'NotNativeAgent', version,
    node: process.execPath, install_root: native, data_root: data }));
  return { base, target, native, data, appdata, log: join(base, 'cli-log') };
}

function run(f, { source, cliBody } = {}) {
  return spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    resolve('install.ps1'), '-InstallDir', f.target, '-NnaInstallRoot', f.native], {
    encoding: 'utf8', windowsHide: true, timeout: 600000,
    env: { ...process.env, APPDATA: f.appdata, NNA_HOME: f.data, NND_TXN_LOG: f.log, NND_TXN_TARGET: f.target },
  });
}

/** Function-level harness: execute the plan resolver with the fake NNA and
 *  prove it stops (never deactivates) the previous registration. */
const planScript = installer => `$ErrorActionPreference='Stop';
$tokens=$null; $errors=$null;
$ast=[Management.Automation.Language.Parser]::ParseFile('${installer}',[ref]$tokens,[ref]$errors);
if($errors.Count){ throw 'Installer PowerShell source does not parse' }
$ast2=[Management.Automation.Language.Parser]::ParseFile((Join-Path (Split-Path -Parent '${installer}') 'scripts\\installer-prebuilt-uninstall-evidence.ps1'),[ref]$tokens,[ref]$errors);
if($errors.Count){ throw 'Evidence helper source does not parse' }
foreach($name in @('Invoke-Native','Get-NndRegistrationStatus','Invoke-NndRegistration','Resolve-NndInstallPlan','Write-NndTransactionRecord')){
  $predicate=[scriptblock]::Create("param(\`$node) \`$node -is [Management.Automation.Language.FunctionDefinitionAst] -and \`$node.Name -eq '$name'");
  $fn=$ast.Find($predicate,$true);
  if(!$fn){ $fn=$ast2.Find($predicate,$true); }
  if(!$fn){ throw "missing function $name" }
  Invoke-Expression $fn.Extent.Text;
}
$SelectedNna=@{ Node=$env:NND_TXN_NODE; Cli=$env:NND_TXN_CLI; DataRoot=$env:NNA_HOME; InstallRoot=$env:NND_TXN_NATIVE };
$plan=Resolve-NndInstallPlan $SelectedNna $env:NND_TXN_TARGET;
[Console]::Out.WriteLine(($plan | ConvertTo-Json -Compress));`;

const readLog = async f => (await readFile(f.log, 'utf8')).split('\n').filter(Boolean).join('\n');

test('the running-install guard matches only the selected install tree and ignores unrelated electron processes',
  { skip: process.platform !== 'win32' }, async t => {
    const f = await fixture(t);
    // Test-InstallRunning first verifies the exe exists, so the fixture
    // installs a placeholder electron binary in the target tree.
    const electronExe = join(f.target, 'packages', 'electron', 'node_modules', 'electron', 'dist');
    await mkdir(electronExe, { recursive: true });
    await writeFile(join(electronExe, 'electron.exe'), '');
    const guard = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', `$ErrorActionPreference='Stop';
function Get-Process([string]$Name) {
  @([pscustomobject]@{ Path = 'C:\\other\\app\\electron.exe' },
    [pscustomobject]@{ Path = Join-Path $env:NND_TXN_TARGET 'packages\\electron\\node_modules\\electron\\dist\\electron.exe' });
}
$tokens=$null; $errors=$null;
$ast=[Management.Automation.Language.Parser]::ParseFile('${resolve('install.ps1').replaceAll("'", "''")}',[ref]$tokens,[ref]$errors);
if($errors.Count){ throw 'Installer PowerShell source does not parse' }
$predicate=[scriptblock]::Create("param(\`$node) \`$node -is [Management.Automation.Language.FunctionDefinitionAst] -and \`$node.Name -eq 'Test-InstallRunning'");
$fn=$ast.Find($predicate,$true);
Invoke-Expression $fn.Extent.Text;
$running = Test-InstallRunning (Join-Path $env:NND_TXN_TARGET 'packages\\electron\\node_modules\\electron\\dist\\electron.exe');
$quiet = Test-InstallRunning (Join-Path $env:NND_TXN_TARGET 'packages\\electron\\node_modules\\electron\\dist\\missing.exe');
[Console]::Out.WriteLine("running=$running quiet=$quiet");`], {
      encoding: 'utf8', windowsHide: true, timeout: 60000,
      env: { ...process.env, NND_TXN_TARGET: f.target },
    });
    assert.equal(guard.status, 0, guard.stderr);
    assert.match(guard.stdout, /running=True quiet=False/u, guard.stdout);
  });

test('the upgrade plan defers deactivation: a copy/build failure cannot mutate the registration',
  { skip: process.platform !== 'win32' }, async t => {
    const f = await fixture(t);
    await writeFile(join(f.native, 'installed', 'src', 'cli.js'), fakeCli(false));
    const plan = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', planScript(resolve('install.ps1'))], {
      encoding: 'utf8', windowsHide: true, timeout: 60000,
      env: { ...process.env, APPDATA: f.appdata, NNA_HOME: f.data, NND_TXN_LOG: f.log,
        NND_TXN_TARGET: f.target, NND_TXN_NATIVE: f.native,
        NND_TXN_NODE: process.execPath, NND_TXN_CLI: join(f.native, 'installed', 'src', 'cli.js') },
    });
    assert.equal(plan.status, 0, plan.stderr);
    const resolved = JSON.parse(plan.stdout.trim().split('\n').pop());
    assert.equal(resolved.Mode, 'upgrade');
    assert.equal(resolved.PreviousVersion, '20261003-5');
    assert.equal(resolved.PreviousRoot.toLowerCase(), f.target.toLowerCase());
    const calls = await readLog(f);
    assert.match(calls, /package status/u, calls);
    assert.match(calls, /service status/u, calls);
    // The transactional promise: the plan stops at most, never deactivates.
    assert.doesNotMatch(calls, /package (de)?activate/u);
  });

test('an activation-transaction failure retains recovery evidence without claiming success',
  { skip: process.platform !== 'win32' }, async t => {
    const f = await fixture(t);
    // Full build succeeds (repo source), then activate is rejected by NNA:
    // the honest outcome is retained evidence plus recovery guidance.
    await writeFile(join(f.native, 'installed', 'src', 'cli.js'), fakeCli(true));
    const result = run(f);
    assert.notEqual(result.status, 0);
    const calls = await readLog(f);
    assert.match(calls, /package deactivate/u, [result.stdout, result.stderr, calls].join('\n'));
    assert.match(calls, /package activate/u, calls);
    assert.match([result.stdout, result.stderr].join('\n'), /activation transaction/u);
    assert.match([result.stdout, result.stderr].join('\n'), /install-transaction\.json/u);
    const record = JSON.parse(await readFile(join(f.appdata, 'NotNativeDesktop', 'install-transaction.json'), 'utf8'));
    assert.equal(record.stage, 'deactivated');
    assert.equal(record.previous_version, '20261003-5');
  });
