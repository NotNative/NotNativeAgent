// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const helper = resolve('scripts/installer-nna-dependency.ps1').replaceAll("'", "''");
const sha = value => createHash('sha256').update(value).digest('hex');
const script = `$ErrorActionPreference='Stop'; . '${helper}';
try { $stage=Stage-NndNnaDependency $env:NND_TEST_RELEASE $env:NND_TEST_HASH $env:NND_TEST_TARGET;
  [Console]::Out.WriteLine('STAGED '+$stage); Remove-NndDependencyStage $stage; exit 0 }
catch { [Console]::Error.WriteLine($_.Exception.Message); exit 12 }`;

async function releaseFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nnd-nna-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = join(root, 'release'); await mkdir(join(release, 'src'), { recursive: true });
  const files = {
    'install.ps1': '[Console]::Out.WriteLine("fixture installer")\n',
    'package.json': JSON.stringify({ name: 'not-native-agent', nna_version: '20261003-1' }),
    'VERSION': '20261003-1\n',
    'src/cli.js': '// fixture\n',
  };
  for (const [name, contents] of Object.entries(files)) await writeFile(join(release, name), contents);
  const manifest = Object.entries(files).sort(([a], [b]) => a.localeCompare(b))
    .map(([name, contents]) => `${sha(contents)} *${name}`).join('\n') + '\n';
  await writeFile(join(release, 'RELEASE_MANIFEST.sha256'), manifest);
  return { root, release, files, manifestHash: sha(manifest) };
}
async function rewriteReleaseFile(fixture, name, content) {
  fixture.files[name] = content;
  await writeFile(join(fixture.release, name), content);
  const manifest = Object.entries(fixture.files).sort(([a], [b]) => a.localeCompare(b))
    .map(([path, value]) => `${sha(value)} *${path}`).join('\n') + '\n';
  await writeFile(join(fixture.release, 'RELEASE_MANIFEST.sha256'), manifest);
  fixture.manifestHash = sha(manifest);
}
function stage(release, hash, { target = '', temp } = {}) {
  return spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 10000,
    env: { ...process.env, Path: '', NND_TEST_RELEASE: release, NND_TEST_HASH: hash,
      NND_TEST_TARGET: target, ...(temp ? { TEMP: temp, TMP: temp } : {}) },
  });
}

test('carried NNA release is staged only when externally pinned manifest and every file agree',
  { skip: process.platform !== 'win32' }, async t => {
    const fixture = await releaseFixture(t);
    const accepted = stage(fixture.release, fixture.manifestHash);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, /^STAGED [A-Z]:\\/imu);
    assert.equal(stage(fixture.release, fixture.manifestHash.toUpperCase()).status, 0);
    const wrong = stage(fixture.release, '0'.repeat(64));
    assert.equal(wrong.status, 12); assert.match(wrong.stderr, /SHA-256 does not match/u);
    await writeFile(join(fixture.release, 'install.ps1'), 'Write-Output "tampered"\n');
    const tampered = stage(fixture.release, fixture.manifestHash);
    assert.equal(tampered.status, 12); assert.match(tampered.stderr, /failed SHA-256 verification/u);
  });

test('carried NNA release rejects unlisted code and missing listed files',
  { skip: process.platform !== 'win32' }, async t => {
    const fixture = await releaseFixture(t);
    await writeFile(join(fixture.release, 'unlisted.ps1'), 'Write-Output "extra"');
    const extra = stage(fixture.release, fixture.manifestHash);
    assert.equal(extra.status, 12); assert.match(extra.stderr, /unlisted/u);
    await rm(join(fixture.release, 'unlisted.ps1'));
    await rm(join(fixture.release, 'src', 'cli.js'));
    const missing = stage(fixture.release, fixture.manifestHash);
    assert.equal(missing.status, 12); assert.match(missing.stderr, /missing a listed file/u);
  });

test('carried NNA release rejects a manifest path that escapes its root',
  { skip: process.platform !== 'win32' }, async t => {
    const fixture = await releaseFixture(t);
    const original = await readFile(join(fixture.release, 'RELEASE_MANIFEST.sha256'), 'utf8');
    const unsafe = original + `${'a'.repeat(64)} *../outside.ps1\n`;
    await writeFile(join(fixture.release, 'RELEASE_MANIFEST.sha256'), unsafe);
    const result = stage(fixture.release, sha(unsafe));
    assert.equal(result.status, 12); assert.match(result.stderr, /unsafe path|invalid entry/u);
  });

test('carried NNA release rejects a reparse point even when it is unlisted',
  { skip: process.platform !== 'win32' }, async t => {
    const fixture = await releaseFixture(t);
    const elsewhere = join(fixture.root, 'elsewhere'); await mkdir(elsewhere);
    try { await symlink(elsewhere, join(fixture.release, 'redirect'), 'junction'); }
    catch (error) { if (error.code === 'EPERM') { t.skip('junction creation is unavailable'); return; } throw error; }
    const result = stage(fixture.release, fixture.manifestHash);
    assert.equal(result.status, 12); assert.match(result.stderr, /reparse point/u);
  });

test('dependency staging refuses a TEMP directory inside the NND target or release source',
  { skip: process.platform !== 'win32' }, async t => {
    const fixture = await releaseFixture(t);
    const target = join(fixture.root, 'NND-target'); await mkdir(target);
    await writeFile(join(target, 'keep.txt'), 'preserved');
    const overlap = stage(fixture.release, fixture.manifestHash, { target, temp: target });
    assert.equal(overlap.status, 12);
    assert.match(overlap.stderr, /staging cannot overlap/u);
    assert.deepEqual(await readdir(target), ['keep.txt']);
    const sourceOverlap = stage(fixture.release, fixture.manifestHash, { target, temp: fixture.release });
    assert.equal(sourceOverlap.status, 12);
    assert.match(sourceOverlap.stderr, /staging cannot overlap/u);
    const alias = join(fixture.root, 'NND-target-alias');
    try { await symlink(target, alias, 'junction'); }
    catch (error) { if (error.code === 'EPERM') return; throw error; }
    const redirected = stage(fixture.release, fixture.manifestHash, { target: alias, temp: target });
    assert.equal(redirected.status, 12);
    assert.match(redirected.stderr, /reparse point/u);
    assert.deepEqual(await readdir(target), ['keep.txt']);
  });

test('one-installer dependency step runs only a staged verified release before NND target mutation',
  { skip: process.platform !== 'win32' }, async t => {
    const fixture = await releaseFixture(t);
    const marker = join(fixture.root, 'nna-installed.txt'), nndTarget = join(fixture.root, 'NND-target');
    await mkdir(nndTarget); await writeFile(join(nndTarget, 'keep.txt'), 'preserved');
    await rewriteReleaseFile(fixture, 'install.ps1', `param([switch]$SkipProviderSetup,[switch]$SkipWebSearchSetup,
[switch]$SkipPlaywrightSetup,[switch]$SkipGatewaySetup,[switch]$SkipRipgrepSetup)
[IO.File]::WriteAllText($env:NND_TEST_DEP_MARKER,'installed')\n`);
    const install = resolve('install.ps1').replaceAll("'", "''");
    const invoke = `$ErrorActionPreference='Stop'; . '${helper}';
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile('${install}',[ref]$tokens,[ref]$errors);
$fn=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Install-RequiredNna'},$true);
Invoke-Expression $fn.Extent.Text;
$NnaDependencyRoot=$env:NND_TEST_RELEASE; $NnaDependencyManifestSha256=$env:NND_TEST_HASH;
$NnaSourceRoot='';$Source=$env:NND_TEST_SOURCE;$InstallNnaIfMissing=$true;
$NnaInstallRoot='';$NnaDataRoot='';$SkipNnaPathUpdate=$false;
function Write-Heading([string]$message) {}
function Get-InstalledNna { if(Test-Path -LiteralPath $env:NND_TEST_DEP_MARKER){return @{ Node='fixture' }}; return $null }
try { Install-RequiredNna; [Console]::Out.WriteLine('DONE'); exit 0 }
catch { [Console]::Error.WriteLine($_.Exception.Message); exit 12 }`;
    function run(hash) {
      return spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', invoke], {
        encoding: 'utf8', windowsHide: true, timeout: 15000,
        env: { ...process.env, Path: '', NND_TEST_RELEASE: fixture.release, NND_TEST_HASH: hash,
          NND_TEST_DEP_MARKER: marker, NND_TEST_SOURCE: fixture.root },
      });
    }
    const invalid = run('0'.repeat(64));
    assert.equal(invalid.status, 12); assert.match(invalid.stderr, /SHA-256 does not match/u);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    assert.equal(await readFile(join(nndTarget, 'keep.txt'), 'utf8'), 'preserved');
    const accepted = run(fixture.manifestHash);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, /DONE/u);
    assert.equal(await readFile(marker, 'utf8'), 'installed');
    assert.equal(await readFile(join(nndTarget, 'keep.txt'), 'utf8'), 'preserved');
    await rewriteReleaseFile(fixture, 'install.ps1', 'exit 21\n');
    await rm(marker);
    const failedInstaller = run(fixture.manifestHash);
    assert.equal(failedInstaller.status, 12);
    assert.match(failedInstaller.stderr, /NNA installation failed/u);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    assert.equal(await readFile(join(nndTarget, 'keep.txt'), 'utf8'), 'preserved');
  });

test('missing dependency digest is rejected by the one-installer entrypoint before NND mutation',
  { skip: process.platform !== 'win32' }, async t => {
    const fixture = await releaseFixture(t);
    const target = join(fixture.root, 'NND-target'); await mkdir(target);
    await writeFile(join(target, 'keep.txt'), 'preserved');
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', resolve('install.ps1'), '-InstallDir', target, '-NnaDependencyRoot', fixture.release], {
      encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...process.env, Path: '' },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires both -NnaDependencyRoot and -NnaDependencyManifestSha256/u);
    assert.equal(await readFile(join(target, 'keep.txt'), 'utf8'), 'preserved');
  });
