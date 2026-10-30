// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createScratchSync } from './scratch.js';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { ensureUserDataPaths, userDataPaths, VERSION } from '../src/product.js';
import { loadManifest, parseCli, readPrompt } from '../src/cli-options.js';
import { discoverLocalProvider, loadStartupManifest } from '../src/onboarding.js';
import { runUninstallCommand } from '../src/uninstall-cli.js';
import { loadWebSearchConfig } from '../src/web-search-config.js';
import { manifestTarget } from '../src/persistence/manifest-files.js';
import { runSoakTurns } from '../scripts/performance-lab-soak.js';

const projectRoot = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/u, (value) => value.slice(1))), '..');

// Windows PowerShell renders terminating errors through the host, which wraps long
// exception lines at the console width and may break mid-token with an indent. The
// installer message is authoritative; tests assert against it host-wrap-free.
const unwrapHostOutput = (value) => String(value).replaceAll(/[ ]*\r\n[ ]*/gu, '');

test('canonical product version uses date and iteration with a SemVer package mapping', async () => {
  const canonical = (await readFile(join(projectRoot, 'VERSION'), 'utf8')).trim();
  const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  const match = /^(\d{8})-([1-9]\d*)$/u.exec(canonical);
  assert.ok(match);
  assert.equal(VERSION, canonical);
  assert.equal(packageJson.nna_version, canonical);
  assert.equal(packageJson.version, `${match[1]}.0.${match[2]}`);
});

test('bare CLI invocation selects the interactive TUI', () => {
  assert.equal(parseCli([]).mode, 'tui');
});

test('AC-HEAD-03 ordinary headless is authenticated stdio and exposes no network listener mode', async () => {
  const headless = await readFile(join(projectRoot, 'src', 'headless.js'), 'utf8');
  const options = await readFile(join(projectRoot, 'src', 'cli-options.js'), 'utf8');
  assert.doesNotMatch(headless, /createServer|\.listen\s*\(/u);
  assert.doesNotMatch(options, /socket_server|http_server|server_mode/u);
  assert.match(await readFile(join(projectRoot, 'docs', 'HEADLESS.md'), 'utf8'), /spawning process is the authenticated controlling principal/iu);
});

test('launch options support prompt, host, and config aliases without breaking legacy modes', () => {
  const baseFields = {
    manifestPath: null, sessionId: null, providerProfile: null,
    providerEndpoint: null, model: null, providerCredentialEnv: null,
    serveAction: null, serveHostname: null, servePort: null,
  };
  assert.deepEqual(parseCli(['-p', 'hello']), {
    ...baseFields, mode: 'text', prompt: ['hello'],
  });
  assert.deepEqual(parseCli(['--config', 'purpose.json', '-p']), {
    ...baseFields, manifestPath: 'purpose.json', mode: 'text', prompt: [],
  });
  assert.equal(parseCli(['host']).mode, 'headless');
  assert.equal(parseCli(['headless']).mode, 'headless');
  assert.equal(parseCli(['--config', 'interactive.json']).mode, 'tui');
  assert.equal(parseCli(['gateway', 'status']).mode, 'gateway');
  assert.deepEqual(parseCli(['session', 'list']).prompt, ['list']);
  assert.equal(parseCli(['session', 'list']).mode, 'sessions');
  assert.deepEqual(parseCli(['gateway', 'status']).prompt, ['status']);
  assert.deepEqual(parseCli(['secrets', 'serve']).prompt, ['serve']);
  assert.deepEqual(parseCli(['webbrowse', 'status']).prompt, ['status']);
  assert.equal(parseCli(['uninstall']).mode, 'uninstall');
  assert.deepEqual(parseCli(['uninstall', '--delete-user-data']).prompt, ['--delete-user-data']);
  assert.deepEqual(parseCli(['uninstall', '--keep-user-data']).prompt, ['--keep-user-data']);
  assert.equal(parseCli(['update']).mode, 'update');
  assert.deepEqual(parseCli(['update', '--check']).prompt, ['--check']);
  const override = parseCli(['--provider-profile', 'remote', '--model', 'qwen', '-p', 'hello']);
  assert.equal(override.providerProfile, 'remote');
  assert.equal(override.model, 'qwen');
  assert.deepEqual(override.prompt, ['hello']);
  assert.equal(parseCli(['-provider', 'Remote Lab']).providerProfile, 'Remote Lab');
  assert.equal(parseCli(['--provider', 'Remote Lab']).providerProfile, 'Remote Lab');
  assert.equal(parseCli(['host', '-provider', 'Remote Lab']).providerProfile, 'Remote Lab');
  assert.throws(() => parseCli(['--provider-credential-env', 'literal-secret!']), { code: 'credential_reference_invalid' });
  assert.throws(() => parseCli(['host', '--model', 'unsafe-override']), { code: 'host_override_requires_manifest' });
  assert.throws(() => parseCli(['host', '-p', 'hello']), { code: 'invalid_option' });
  assert.throws(() => parseCli(['host', '-p', 'hello', '--provider-endpoint', 'https://example.invalid/v1',
    '--provider-credential-env', 'HOST_SECRET']), { code: 'invalid_option' });
  assert.throws(() => parseCli(['opencode', '--prompt', 'hello']), { code: 'invalid_option' });
  assert.equal(parseCli(['text', '-p', 'hello']).mode, 'text');
});

test('CLI bounds manifest reads and direct prompt arguments before parsing or concatenation', async () => {
  const root = createScratchSync('nna-cli-bounds-');
  try {
    const oversized = join(root, 'oversized.json');
    await writeFile(oversized, Buffer.alloc(1_048_577, 0x20));
    await assert.rejects(loadManifest(oversized), { code: 'manifest_too_large' });
    await assert.rejects(loadManifest(root), { code: 'manifest_invalid' });
    await assert.rejects(readPrompt(null, ['x'.repeat(131_073)]), { code: 'content_too_large' });
    await assert.rejects(readPrompt(null, ['€'.repeat(43_691)]), { code: 'content_too_large' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('uninstall command rejects conflicting or unknown deletion choices before launch', async () => {
  await assert.rejects(runUninstallCommand(['--delete-user-data', '--keep-user-data']), { code: 'uninstall_option_conflict' });
  await assert.rejects(runUninstallCommand(['--force']), { code: 'uninstall_option_invalid' });
});

test('Windows uninstall helpers run under the powershell.exe runtime without removing files', {
  skip: process.platform !== 'win32',
}, () => {
  const installation = 'C:\\Test\\NotNativeAgent';
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$tokens = $null; $parseErrors = $null',
    '$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:NNA_TEST_UNINSTALL_SCRIPT, [ref]$tokens, [ref]$parseErrors)',
    "if ($parseErrors.Count -gt 0) { throw 'uninstall script did not parse' }",
    "foreach ($name in @('New-UninstallChallenge', 'Get-UninstallMutexHash')) {",
    '  $functions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)',
    "  if ($functions.Count -ne 1) { throw \"missing helper $name\" }",
    '  . ([scriptblock]::Create($functions[0].Extent.Text))',
    '}',
    '1..16 | ForEach-Object { $challenge = New-UninstallChallenge; if ($challenge -lt 100000 -or $challenge -ge 1000000) { throw "challenge outside six-digit range" } }',
    `$hash = Get-UninstallMutexHash '${installation}'`,
    `$caseAlias = Get-UninstallMutexHash '${installation.toLowerCase()}'`,
    "if ($hash -ne $caseAlias) { throw 'case aliases acquired different uninstall locks' }",
    'Write-Output $hash',
  ].join('\n');
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, NNA_TEST_UNINSTALL_SCRIPT: join(projectRoot, 'uninstall.ps1') },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const expected = createHash('sha256').update(installation.toUpperCase(), 'utf8').digest('hex').slice(0, 24).toUpperCase();
  assert.equal(result.stdout.trim(), expected);
});

test('Windows uninstall attempts both service stops and reports a failed native exit', {
  skip: process.platform !== 'win32',
}, async () => {
  const root = createScratchSync('nna-uninstall-stop-');
  const fakeNode = join(root, 'fake-node.cmd');
  const log = join(root, 'stops.txt');
  try {
    await writeFile(fakeNode, '@echo off\r\necho %2:%4>>"%NNA_TEST_STOP_LOG%"\r\nif /I "%2"=="gateway" exit /b 7\r\nexit /b 0\r\n', 'utf8');
    const script = [
      "$ErrorActionPreference = 'Stop'",
      '$tokens = $null; $parseErrors = $null',
      '$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:NNA_TEST_UNINSTALL_SCRIPT, [ref]$tokens, [ref]$parseErrors)',
      "if ($parseErrors.Count -gt 0) { throw 'uninstall script did not parse' }",
      "foreach ($name in @('Invoke-UninstallServiceStop', 'Assert-UninstallNodePath', 'Get-UninstallOpenCodeEnvironment', 'Test-UninstallOpenCodeEnvironmentOwner')) {",
      '  $helper = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)',
      '  if ($helper.Count -ne 1) { throw "missing helper $name" }',
      '  . ([scriptblock]::Create($helper[0].Extent.Text))',
      '}',
      'Assert-UninstallNodePath $env:NNA_TEST_FAKE_NODE',
      'Set-Location ((Split-Path -Qualifier $env:NNA_TEST_FAKE_NODE) + "\\")',
      '$rootRelative = $env:NNA_TEST_FAKE_NODE.Substring(2)',
      "if (-not (Test-Path -LiteralPath $rootRelative -PathType Leaf)) { throw 'root-relative fixture is missing' }",
      '$rejected = $false; try { Assert-UninstallNodePath $rootRelative } catch { $rejected = $true }',
      "if (-not $rejected) { throw 'root-relative node path was accepted' }",
      "$gatewayStopped = Invoke-UninstallServiceStop $env:NNA_TEST_FAKE_NODE 'ignored-cli' 'gateway'",
      "$opencodeStopped = Invoke-UninstallServiceStop $env:NNA_TEST_FAKE_NODE 'ignored-cli' 'opencode' -PreserveEnvironment",
      "$missingStopped = Invoke-UninstallServiceStop (Join-Path $env:TEMP 'nna-uninstall-missing-node.exe') 'ignored-cli' 'gateway'",
      "if ($gatewayStopped -ne $false -or $opencodeStopped -ne $true -or $missingStopped -ne $false) { throw 'service-stop outcomes were lost' }",
      "$expected = Get-UninstallOpenCodeEnvironment ([pscustomobject]@{ hostname = '::1'; port = 4095; username = 'opencode'; password = 'uninstall-environment-password-value' })",
      "if ($expected.OPENCODE_HOST -ne 'http://[::1]:4095' -or $expected.OPENCODE_SERVER_USERNAME -ne '') { throw 'OpenCode ownership tuple is malformed' }",
      "$caseSensitiveUsername = Get-UninstallOpenCodeEnvironment ([pscustomobject]@{ hostname = 'localhost'; port = 4095; username = 'OPENCODE'; password = 'uninstall-environment-password-value' })",
      "if ($caseSensitiveUsername.OPENCODE_SERVER_USERNAME -cne 'OPENCODE') { throw 'case-sensitive OpenCode username was normalized as the default' }",
      "$trimmedUsername = Get-UninstallOpenCodeEnvironment ([pscustomobject]@{ hostname = 'localhost'; port = 4095; username = ' opencode '; password = 'uninstall-environment-password-value' })",
      "if ($trimmedUsername.OPENCODE_SERVER_USERNAME -ne '') { throw 'default OpenCode username whitespace was not normalized' }",
      "$current = @{}; foreach ($name in $expected.Keys) { $current[$name] = $expected[$name] }; if (-not (Test-UninstallOpenCodeEnvironmentOwner $expected $current)) { throw 'matching OpenCode tuple was not recognized' }",
      "$current.OPENCODE_HOST = 'http://other:4095'; if (Test-UninstallOpenCodeEnvironmentOwner $expected $current) { throw 'foreign OpenCode tuple was treated as owned' }",
    ].join('\n');
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
    ], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, NNA_TEST_UNINSTALL_SCRIPT: join(projectRoot, 'uninstall.ps1'),
        NNA_TEST_FAKE_NODE: fakeNode, NNA_TEST_STOP_LOG: log },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stderr, /gateway service could not be stopped cleanly \(exit code 7\)/u);
    assert.deepEqual((await readFile(log, 'utf8')).trim().split(/\r?\n/u), ['gateway:', 'opencode:--preserve-environment']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows uninstall recovery state is bound to the marker and survives partial payload deletion', {
  skip: process.platform !== 'win32',
}, async () => {
  const root = createScratchSync('nna-uninstall-recovery-');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$tokens = $null; $parseErrors = $null',
    '$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:NNA_TEST_UNINSTALL_SCRIPT, [ref]$tokens, [ref]$parseErrors)',
    "if ($parseErrors.Count -gt 0) { throw 'uninstall script did not parse' }",
    "foreach ($name in @('Get-UninstallMarkerHash', 'Test-UninstallRecoveryState', 'Write-UninstallRecoveryState', 'Remove-UninstallPayloadPreservingState')) {",
    '  $helper = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)',
    '  if ($helper.Count -ne 1) { throw "missing helper $name" }',
    '  . ([scriptblock]::Create($helper[0].Extent.Text))',
    '}',
    '$fixture = $env:NNA_TEST_RECOVERY_ROOT; New-Item -ItemType Directory -Path $fixture -Force | Out-Null',
    '$marker = Join-Path $fixture "install.json"; [pscustomobject]@{ product = "NotNativeAgent" } | ConvertTo-Json | Set-Content -LiteralPath $marker -Encoding UTF8',
    '$state = Join-Path $fixture ".nna-uninstall-state.json"; $installer = Join-Path $fixture "uninstall.ps1"; [IO.File]::WriteAllText($installer, "fixture")',
    'Write-UninstallRecoveryState $state $fixture $marker',
    "if (-not (Test-UninstallRecoveryState $state $fixture $marker)) { throw 'matching recovery state was rejected' }",
    '$parsed = Get-Content -LiteralPath $state -Raw -Encoding UTF8 | ConvertFrom-Json; $parsed.product = "Other"; $parsed | ConvertTo-Json -Compress | Set-Content -LiteralPath $state -Encoding UTF8',
    "if (Test-UninstallRecoveryState $state $fixture $marker) { throw 'tampered product was accepted' }",
    'Remove-Item -LiteralPath $state -Force; Write-UninstallRecoveryState $state $fixture $marker',
    '$parsed = Get-Content -LiteralPath $state -Raw -Encoding UTF8 | ConvertFrom-Json; $parsed.install_root = (Join-Path $fixture "other"); $parsed | ConvertTo-Json -Compress | Set-Content -LiteralPath $state -Encoding UTF8',
    "if (Test-UninstallRecoveryState $state $fixture $marker) { throw 'tampered install root was accepted' }",
    'Remove-Item -LiteralPath $state -Force; Write-UninstallRecoveryState $state $fixture $marker',
    '$parsed = Get-Content -LiteralPath $state -Raw -Encoding UTF8 | ConvertFrom-Json; $parsed.services_stopped = @("gateway"); $parsed | ConvertTo-Json -Compress | Set-Content -LiteralPath $state -Encoding UTF8',
    "if (Test-UninstallRecoveryState $state $fixture $marker) { throw 'incomplete stop state was accepted' }",
    'Remove-Item -LiteralPath $state -Force; Write-UninstallRecoveryState $state $fixture $marker',
    '[pscustomobject]@{ product = "Changed" } | ConvertTo-Json | Set-Content -LiteralPath $marker -Encoding UTF8',
    "if (Test-UninstallRecoveryState $state $fixture $marker) { throw 'changed marker hash was accepted' }",
    '[pscustomobject]@{ product = "NotNativeAgent" } | ConvertTo-Json | Set-Content -LiteralPath $marker -Encoding UTF8',
    'Remove-Item -LiteralPath $state -Force; New-Item -ItemType Directory -Path $state | Out-Null',
    "if (Test-UninstallRecoveryState $state $fixture $marker) { throw 'directory was accepted as a recovery-state file' }",
    'Remove-Item -LiteralPath $state -Force -Recurse; Write-UninstallRecoveryState $state $fixture $marker',
    '$payload = Join-Path $fixture "payload"; New-Item -ItemType Directory -Path $payload | Out-Null',
    '$removable = Join-Path $fixture "a-removable.txt"; [IO.File]::WriteAllText($removable, "removable")',
    '$locked = Join-Path $payload "locked.txt"; [IO.File]::WriteAllText($locked, "locked")',
    '$lock = [IO.File]::Open($locked, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)',
    '$failed = $false; try { Remove-UninstallPayloadPreservingState $fixture } catch { $failed = $true }',
    "if (-not $failed) { throw 'locked payload did not fail removal' }",
    'foreach ($required in @($marker, $state, $installer)) { if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "recovery artifact was lost: $required" } }',
    '$lock.Dispose(); Remove-UninstallPayloadPreservingState $fixture',
    "if (Test-Path -LiteralPath $payload) { throw 'payload remained after retry' }",
    'foreach ($required in @($marker, $state, $installer)) { if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "recovery artifact was lost after retry: $required" } }',
  ].join('\n');
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], { encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, NNA_TEST_UNINSTALL_SCRIPT: join(projectRoot, 'uninstall.ps1'), NNA_TEST_RECOVERY_ROOT: root } });
  try { assert.equal(result.status, 0, result.stderr || result.stdout); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows uninstall preflight rejects unsafe roots and reads UTF-8 markers before confirmation', {
  skip: process.platform !== 'win32',
}, async () => {
  const root = createScratchSync('nna-uninstall-preflight-');
  const app = join(root, 'app-é');
  const data = join(root, 'data-é');
  const uninstall = join(projectRoot, 'uninstall.ps1');
  const run = (installRoot) => spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', uninstall,
    '-InstallRoot', installRoot, '-KeepUserData', '-SkipPathUpdate',
  ], { encoding: 'utf8', timeout: 10_000 });
  try {
    await mkdir(app, { recursive: true });
    await mkdir(data, { recursive: true });
    const marker = { product: 'NotNativeAgent', install_root: app, data_root: data };
    await writeFile(join(app, 'install.json'), JSON.stringify(marker), 'utf8');
    const valid = run(app);
    assert.notEqual(valid.status, 0);
    assert.match(valid.stderr, /directly attached interactive terminal/u);
    assert.equal(existsSync(app), true);
    assert.equal(existsSync(data), true);

    const driveRoot = run(parse(app).root);
    assert.match(driveRoot.stderr, /unsafe install root/u);
    const driveRelative = run(`${parse(app).root.slice(0, 2)}relative`);
    assert.match(driveRelative.stderr, /fully qualified directory/u);
    const profileRoot = run(homedir());
    assert.match(profileRoot.stderr, /unsafe install root/u);
    const localAppDataRoot = run(process.env.LOCALAPPDATA);
    assert.match(localAppDataRoot.stderr, /unsafe install root/u);

    await writeFile(join(app, 'install.json'), JSON.stringify({ ...marker, data_root: 'relative-data' }), 'utf8');
    const relativeData = run(app);
    assert.match(relativeData.stderr, /user data root must be an absolute directory/u);
    assert.equal(existsSync(app), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('first run persists explicit environment configuration and reuses it', async () => {
  const root = createScratchSync('nna-onboarding-');
  const paths = userDataPaths({ home: root, environment: {} });
  await ensureUserDataPaths(paths);
  try {
    const environment = { NNA_PROVIDER_ENDPOINT: 'http://127.0.0.1:11434/v1', NNA_MODEL: 'starter-model' };
    const first = await loadStartupManifest({ paths, environment, discover: async () => null });
    assert.equal(first.routes.primary.model, 'starter-model');
    assert.equal(JSON.parse(await readFile(join(paths.config, 'manifest.json'), 'utf8')).format_version, 1);
    let discovered = false;
    const second = await loadStartupManifest({
      paths, environment: {}, discover: async () => { discovered = true; return null; },
    });
    assert.equal(second.routes.primary.model, 'starter-model');
    assert.equal(discovered, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('concurrent first-run manifests publish one complete winner and quarantine malformed JSON', async () => {
  const root = createScratchSync('nna-onboarding-atomic-');
  const paths = userDataPaths({ home: root, environment: {} });
  await ensureUserDataPaths(paths);
  const environment = (model) => ({ NNA_PROVIDER_ENDPOINT: 'http://127.0.0.1:11434/v1', NNA_MODEL: model });
  try {
    const results = await Promise.all([
      loadStartupManifest({ paths, environment: environment('first-model'), discover: async () => null }),
      loadStartupManifest({ paths, environment: environment('second-model'), discover: async () => null }),
    ]);
    assert.equal(results[0].routes.primary.model, results[1].routes.primary.model);
    const path = join(paths.config, 'manifest.json');
    const persisted = JSON.parse(await readFile(path, 'utf8'));
    assert.equal((persisted.providers?.[0] ?? persisted.provider).model, results[0].routes.primary.model);
    await writeFile(path, '{"format_version":', 'utf8');
    await assert.rejects(loadStartupManifest({ paths, environment: {}, discover: async () => null }), (error) => {
      assert.equal(error.code, 'manifest_invalid');
      assert.match(error.message, /default manifest is malformed; preserved at .*\.corrupt-\d+/u);
      return true;
    });
    const names = await readdir(paths.config);
    assert.equal(names.includes('manifest.json'), false);
    assert.equal(names.filter((name) => /^manifest\.json\.corrupt-\d+$/u.test(name)).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('AC-SESS-08 legacy configuration migrates once with backup and future formats fail safely', async () => {
  const root = createScratchSync('nna-config-migration-');
  const paths = userDataPaths({ home: root, environment: {} });
  await ensureUserDataPaths(paths);
  const path = join(paths.config, 'manifest.json');
  const legacy = { provider: { id: 'local', endpoint: 'http://127.0.0.1:11434/v1', model: 'm', trust_zone: 'loopback' } };
  try {
    await writeFile(path, `${JSON.stringify(legacy)}\n`, 'utf8');
    await loadStartupManifest({ paths, environment: {}, discover: async () => null });
    assert.equal(JSON.parse(await readFile(path, 'utf8')).format_version, 1);
    assert.deepEqual(JSON.parse(await readFile(`${path}.bak`, 'utf8')), legacy);
    await loadStartupManifest({ paths, environment: {}, discover: async () => null });
    assert.deepEqual(JSON.parse(await readFile(`${path}.bak`, 'utf8')), legacy);
    await writeFile(path, `${JSON.stringify({ ...legacy, format_version: 2 })}\n`, 'utf8');
    await assert.rejects(loadStartupManifest({ paths, environment: {}, discover: async () => null }), { code: 'manifest_version_future' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('local discovery selects the first sorted model from the first ready endpoint', async () => {
  const manifest = await discoverLocalProvider({ probe: async (endpoint) => (
    endpoint.includes('11434') ? { endpoint, models: ['z-model', 'a-model'] } : null
  ) });
  assert.equal(manifest.provider.model, 'a-model');
  assert.equal(manifest.provider.trust_zone, 'loopback');
});

test('first run without discovery requires a real terminal', async () => {
  const root = createScratchSync('nna-onboarding-required-');
  const paths = userDataPaths({ home: root, environment: {} });
  await ensureUserDataPaths(paths);
  try {
    await assert.rejects(loadStartupManifest({
      paths, environment: {}, discover: async () => null, input: { isTTY: false }, output: { isTTY: false },
    }), { code: 'setup_required' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('version bump synchronizes canonical, runtime, package, and SBOM versions', async () => {
  const root = createScratchSync('nna-version-bump-');
  try {
    await mkdir(join(root, 'scripts')); await mkdir(join(root, 'src')); await mkdir(join(root, 'desktop'));
    for (const path of ['VERSION', 'package.json', 'SBOM.spdx.json']) {
      await copyFile(join(projectRoot, path), join(root, path));
    }
    await copyFile(join(projectRoot, 'src', 'product.js'), join(root, 'src', 'product.js'));
    await copyFile(join(projectRoot, 'scripts', 'bump-version.js'), join(root, 'scripts', 'bump-version.js'));
    for (const path of ['VERSION', 'package.json']) {
      await copyFile(join(projectRoot, 'desktop', path), join(root, 'desktop', path));
    }
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'bump-version.js'), '--date', '20991231', '--iteration', '7'], {
      cwd: root, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await readFile(join(root, 'VERSION'), 'utf8')).trim(), '20991231-7');
    const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const sbom = JSON.parse(await readFile(join(root, 'SBOM.spdx.json'), 'utf8'));
    assert.equal(packageJson.version, '20991231.0.7');
    assert.equal(packageJson.nna_version, '20991231-7');
    assert.equal((await readFile(join(root, 'desktop', 'VERSION'), 'utf8')).trim(), '20991231-7');
    assert.equal(JSON.parse(await readFile(join(root, 'desktop', 'package.json'), 'utf8')).desktop_version, '20991231-7');
    assert.equal(sbom.packages[0].versionInfo, '20991231-7');
    assert.match(await readFile(join(root, 'src', 'product.js'), 'utf8'), /VERSION = '20991231-7'/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('product data paths are stable, home-scoped, and overrideable only absolutely', async () => {
  const root = createScratchSync('nna-paths-');
  try {
    const defaults = userDataPaths({ home: root, environment: {} });
    assert.equal(defaults.root, resolve(root, '.nna'));
    await ensureUserDataPaths(defaults);
    for (const name of ['sessions', 'reviewer-ledger', 'config', 'logs', 'support']) {
      assert.equal(existsSync(join(defaults.root, name)), true);
    }
    const managed = userDataPaths({ home: root, environment: { NNA_HOME: join(root, 'managed') } });
    assert.equal(managed.root, resolve(root, 'managed'));
    assert.throws(() => userDataPaths({ home: root, environment: { NNA_HOME: 'relative' } }), { code: 'invalid_nna_home' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('installer sources declare per-user locations and preserve data by default', async () => {
  const windowsInstall = await readFile(join(projectRoot, 'install.ps1'), 'utf8');
  const windowsUninstall = await readFile(join(projectRoot, 'uninstall.ps1'), 'utf8');
  const linuxInstall = await readFile(join(projectRoot, 'install.sh'), 'utf8');
  const unixUninstall = await readFile(join(projectRoot, 'uninstall.sh'), 'utf8');
  assert.match(windowsInstall, /LocalApplicationData/u);
  assert.match(windowsInstall, /UserProfile/u);
  assert.match(windowsInstall, /\.nna/u);
  assert.match(windowsInstall, /SHASUMS256\.txt/u);
  assert.match(windowsInstall, /Get-OfficialNodeDownloadBase/u);
  assert.match(windowsInstall, /Uri\.Host -ne 'nodejs\.org'/u);
  assert.match(windowsInstall, /\$Client\.Dispose\(\)/u);
  assert.match(windowsInstall, /SecurityProtocol = \$PriorSecurityProtocol/u);
  assert.doesNotMatch(windowsInstall, /icacls/iu);
  assert.doesNotMatch(windowsInstall, /Get-ChildItem[^\r\n]+-Force -Recurse/u);
  assert.match(windowsInstall, /prepared with inherited parent ACLs/u);
  assert.match(windowsInstall, /ForceBundledNode/u);
  assert.match(windowsInstall, /Join-Path \$InstallRoot 'installed'/u);
  assert.match(windowsInstall, /'package\.json', 'VERSION', 'LICENSE'/u);
  assert.match(windowsInstall, /Join-Path \$BinRoot 'nna\.ps1'/u);
  assert.match(windowsInstall, /Join-Path \$InstallRoot 'uninstall\.ps1'/u);
  assert.match(windowsInstall, /\$PriorNnaHome/u);
  assert.match(windowsInstall, /SkipWebSearchSetup/u);
  assert.match(windowsInstall, /WebSearch is already configured/u);
  assert.match(windowsInstall, /SkipPlaywrightSetup/u);
  assert.match(windowsInstall, /Playwright Chromium v.*already installed; setup skipped/u);
  assert.match(windowsInstall, /webbrowse verify/u);
  assert.match(windowsInstall, /base URL of your existing SearXNG server/u);
  assert.match(windowsInstall, /function Invoke-WebSearchInstallerAction/u);
  assert.match(windowsInstall, /WebSearch setup action[^\r\n]+failed validation/u);
  assert.match(windowsInstall, /WebSearch validation failed; no WebSearch configuration was saved/u);
  assert.match(windowsInstall, /Test-LegacyGatewayTask/u);
  assert.match(windowsInstall, /NotNativeAgentGateway/u);
  assert.match(windowsInstall, /Unregister-ScheduledTask/u);
  assert.match(windowsInstall, /Unregister-ScheduledTask[^\r\n]+-ErrorAction Stop/u);
  assert.match(windowsInstall, /still registered after removal/u);
  assert.match(windowsInstall, /-Verb RunAs/u);
  assert.match(windowsInstall, /does not target the legacy NNA gateway/u);
  assert.match(windowsInstall, /GatewayWasRunning/u);
  assert.match(windowsInstall, /function Invoke-GatewayInstallerAction/u);
  assert.match(windowsInstall, /Telegram gateway action[^\r\n]+failed/u);
  for (const action of ['token-stdin', 'authorize', 'workspace', 'enable', 'test', 'stop', 'start']) {
    assert.match(windowsInstall, new RegExp(`Invoke-GatewayInstallerAction[^\\r\\n]+['"]${action}['"]`, 'u'));
  }
  assert.ok(windowsInstall.lastIndexOf('Stop-GatewayBeforePayloadReplacement')
    < windowsInstall.indexOf('Remove-Item -LiteralPath $Target -Recurse -Force'));
  assert.match(windowsInstall, /existing runtime files were preserved/u);
  assert.match(windowsInstall, /Telegram gateway restarted on the updated runtime/u);
  assert.match(windowsInstall, /function Stop-OpencodeServiceBeforePayloadReplacement/u);
  assert.match(windowsInstall, /Stop-OpencodeServiceBeforePayloadReplacement \$NodePath/u);
  assert.ok(windowsInstall.lastIndexOf('Stop-OpencodeServiceBeforePayloadReplacement')
    < windowsInstall.indexOf('Remove-Item -LiteralPath $Target -Recurse -Force'));
  assert.match(windowsInstall, /OpenCode service did not stop within 30 seconds/u);
  assert.match(windowsInstall, /function Invoke-OpencodeInstallerAction/u);
  assert.match(windowsInstall, /OpenCode service action[^\r\n]+failed/u);
  for (const action of ['status', 'enable', 'stop', 'start']) {
    assert.match(windowsInstall, new RegExp(`Invoke-OpencodeInstallerAction[^\\r\\n]+['"]${action}['"]`, 'u'));
  }
  assert.match(windowsInstall, /OpenCode service login wiring refreshed for the updated runtime/u);
  assert.match(windowsInstall, /OpenCode service restarted on the updated runtime/u);
  assert.match(windowsInstall, /not enabled; run nna opencode enable to install its login wiring/u);
  assert.match(windowsInstall, /could not be inspected while waiting for its runtime to stop/u);
  assert.match(windowsInstall, /\$OpencodeWasRunning = \$OpencodeStoppedForUpgrade -or \[bool\]\$OpencodeStatus\.runtime\.running/u);
  assert.match(windowsUninstall, /Invoke-UninstallServiceStop \$NodePath \$InstalledCli 'opencode' -PreserveEnvironment/u);
  const installRemoval = windowsUninstall.indexOf('Remove-UninstallPayloadPreservingState $InstallRoot');
  assert.ok(installRemoval >= 0);
  assert.ok(windowsUninstall.indexOf('NotNativeAgent-Telegram.vbs') > installRemoval);
  assert.ok(windowsUninstall.indexOf('NotNativeAgent-UserPath-') > installRemoval);
  assert.ok(windowsUninstall.indexOf('Clear-UninstallOpenCodeEnvironment $DataRoot') > installRemoval);
  assert.match(windowsUninstall, /NotNativeAgent-OpenCode\.vbs/u);
  assert.match(windowsUninstall, /startup entry .* belongs to another NNA installation/u);
  assert.doesNotMatch(windowsUninstall, /OpencodeOwnedByThisInstall/u);
  assert.match(windowsUninstall, /Test-UninstallOpenCodeEnvironmentOwner/u);
  assert.match(windowsInstall, /--disable-warning=ExperimentalWarning/u);
  assert.match(windowsUninstall, /DeleteUserData/u);
  assert.match(windowsUninstall, /KeepUserData/u);
  assert.match(windowsUninstall, /ParentProcessId/u);
  assert.match(windowsUninstall, /IsInputRedirected/u);
  assert.match(windowsUninstall, /UNINSTALL \$Challenge/u);
  assert.match(windowsUninstall, /Permanently delete all NNA user data/u);
  assert.match(windowsUninstall, /belongs to another NNA installation and was preserved/u);
  assert.match(linuxInstall, /HOME\/\.local\/share/u);
  assert.match(linuxInstall, /Darwin/u);
  assert.match(linuxInstall, /Application Support\/NotNativeAgent/u);
  assert.match(linuxInstall, /shasum -a 256/u);
  assert.match(linuxInstall, /tar\.gz/u);
  assert.match(linuxInstall, /HOME\/\.nna/u);
  assert.match(linuxInstall, /sha256sum/u);
  assert.match(linuxInstall, /apt-get|dnf|yum|zypper/u);
  assert.match(linuxInstall, /target="\$install_root\/installed"/u);
  assert.match(linuxInstall, /for file in package\.json VERSION LICENSE/u);
  assert.match(linuxInstall, /\$install_root\/uninstall\.sh/u);
  assert.match(linuxInstall, /--skip-websearch-setup/u);
  assert.match(linuxInstall, /WebSearch is already configured/u);
  assert.match(linuxInstall, /--skip-playwright-setup/u);
  assert.match(linuxInstall, /Playwright Chromium v.*already installed; setup skipped/u);
  assert.match(linuxInstall, /PATH="\$node_dir:\$PATH" PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD/u);
  assert.match(linuxInstall, /webbrowse verify/u);
  assert.match(linuxInstall, /base URL of your existing SearXNG server/u);
  assert.match(linuxInstall, /gateway_running/u);
  assert.ok(linuxInstall.indexOf('Stopping the running Telegram gateway before replacing its runtime files')
    < linuxInstall.indexOf('rm -rf -- "$target"'));
  assert.match(linuxInstall, /gateway_stopped_for_upgrade/u);
  assert.match(linuxInstall, /systemctl --user restart notnativeagent-telegram\.service/u);
  assert.match(linuxInstall, /Telegram gateway restarted on the updated runtime/u);
  assert.match(linuxInstall, /nna_runtime/u);
  assert.match(linuxInstall, /--disable-warning=ExperimentalWarning/u);
  assert.match(unixUninstall, /Darwin/u);
  assert.match(unixUninstall, /Application Support\/NotNativeAgent/u);
  assert.match(unixUninstall, /--keep-user-data/u);
  assert.match(unixUninstall, /\[ -t 0 \] && \[ -t 1 \]/u);
  assert.match(unixUninstall, /UNINSTALL %s/u);
  assert.match(unixUninstall, /Permanently delete all NNA user data/u);
});

test('Windows installer rejects an invalid explicit WebSearch endpoint without reporting success', {
  skip: process.platform !== 'win32', timeout: 30_000,
}, async () => {
  const root = createScratchSync('nna-invalid-websearch-install-');
  const app = join(root, 'app');
  const data = join(root, 'home', '.nna');
  try {
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(projectRoot, 'install.ps1'),
      '-SourceRoot', projectRoot, '-InstallRoot', app, '-DataRoot', data,
      '-SkipPathUpdate', '-SkipDependencyInstall', '-SkipRipgrepSetup', '-SkipProviderSetup',
      '-SkipPlaywrightSetup', '-SkipGatewaySetup', '-WebSearchEndpoint', 'http://127.0.0.1:1',
    ], { cwd: root, encoding: 'utf8', timeout: 25_000 });
    assert.notEqual(result.status, 0, result.stdout);
    assert.doesNotMatch(result.stdout, /WebSearch configured at|WebSearch configured and validated/u);
    assert.match(`${result.stdout}\n${result.stderr}`, /failed validation/u);
    assert.equal((await loadWebSearchConfig(join(data, 'config', 'web-search.json'))).enabled, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows installer rejects a writable existing data root before replacing the application', {
  skip: process.platform !== 'win32', timeout: 30_000,
}, async () => {
  const root = createScratchSync('nna-unsafe-data-install-');
  const app = join(root, 'app');
  const data = join(root, 'home', '.nna');
  try {
    await mkdir(data, { recursive: true });
    const grant = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
      $ErrorActionPreference = 'Stop'
      $path = [Console]::In.ReadToEnd()
      $acl = ([IO.DirectoryInfo]::new($path)).GetAccessControl()
      $rule = [Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new('S-1-1-0'),
        [Security.AccessControl.FileSystemRights]::Modify,
        [Security.AccessControl.AccessControlType]::Allow)
      $acl.AddAccessRule($rule)
      ([IO.DirectoryInfo]::new($path)).SetAccessControl($acl)
    `], { input: data, encoding: 'utf8', timeout: 5000 });
    assert.equal(grant.status, 0, grant.stderr);
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(projectRoot, 'install.ps1'),
      '-SourceRoot', projectRoot, '-InstallRoot', app, '-DataRoot', data,
      '-SkipPathUpdate', '-SkipDependencyInstall', '-SkipRipgrepSetup', '-SkipProviderSetup',
      '-SkipPlaywrightSetup', '-SkipGatewaySetup',
    ], { cwd: root, encoding: 'utf8', timeout: 20_000 });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(`${result.stdout}\n${result.stderr}`, /Unsafe NNA user data directory ACL.*\.nna/u);
    assert.doesNotMatch(result.stdout, /INSTALL COMPLETE/u);
    assert.equal(existsSync(app), false, 'unsafe data must stop installation before payload mutation');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows installer rejects write access inherited by a newly created data root before replacing the application', {
  skip: process.platform !== 'win32', timeout: 30_000,
}, async () => {
  const root = createScratchSync('nna-inherited-data-install-');
  const app = join(root, 'app');
  const home = join(root, 'home');
  const data = join(home, '.nna');
  try {
    await mkdir(home);
    const grant = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
      $ErrorActionPreference = 'Stop'
      $path = [Console]::In.ReadToEnd()
      $info = [IO.DirectoryInfo]::new($path)
      $acl = $info.GetAccessControl()
      $rule = [Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new('S-1-1-0'),
        [Security.AccessControl.FileSystemRights]::Modify,
        [Security.AccessControl.InheritanceFlags]::ContainerInherit,
        [Security.AccessControl.PropagationFlags]::InheritOnly,
        [Security.AccessControl.AccessControlType]::Allow)
      $acl.AddAccessRule($rule)
      $info.SetAccessControl($acl)
    `], { input: home, encoding: 'utf8', timeout: 5000 });
    assert.equal(grant.status, 0, grant.stderr);
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(projectRoot, 'install.ps1'),
      '-SourceRoot', projectRoot, '-InstallRoot', app, '-DataRoot', data,
      '-SkipPathUpdate', '-SkipDependencyInstall', '-SkipRipgrepSetup', '-SkipProviderSetup',
      '-SkipPlaywrightSetup', '-SkipGatewaySetup',
    ], { cwd: root, encoding: 'utf8', timeout: 20_000 });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(`${result.stdout}\n${result.stderr}`, /Unsafe NNA user data directory ACL.*\.nna/u);
    assert.doesNotMatch(result.stdout, /INSTALL COMPLETE/u);
    assert.equal(existsSync(app), false, 'unsafe inheritance must stop installation before payload mutation');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows installer rejects an unsafe existing startup manifest before replacing the application', {
  skip: process.platform !== 'win32', timeout: 30_000,
}, async () => {
  const root = createScratchSync('nna-unsafe-manifest-install-');
  const app = join(root, 'app');
  const data = join(root, 'home', '.nna');
  const manifest = join(data, 'config', 'manifest.json');
  try {
    await mkdir(join(data, 'config'), { recursive: true });
    await writeFile(manifest, '{}\n');
    const grant = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
      $ErrorActionPreference = 'Stop'
      $path = [Console]::In.ReadToEnd()
      $info = [IO.FileInfo]::new($path)
      $acl = $info.GetAccessControl()
      $rule = [Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new('S-1-1-0'),
        [Security.AccessControl.FileSystemRights]::Modify,
        [Security.AccessControl.AccessControlType]::Allow)
      $acl.AddAccessRule($rule)
      $info.SetAccessControl($acl)
    `], { input: manifest, encoding: 'utf8', timeout: 5000 });
    assert.equal(grant.status, 0, grant.stderr);
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(projectRoot, 'install.ps1'),
      '-SourceRoot', projectRoot, '-InstallRoot', app, '-DataRoot', data,
      '-SkipPathUpdate', '-SkipDependencyInstall', '-SkipRipgrepSetup', '-SkipProviderSetup',
      '-SkipPlaywrightSetup', '-SkipGatewaySetup',
    ], { cwd: root, encoding: 'utf8', timeout: 20_000 });
    const launch = result.status === 0 ? spawnSync(process.execPath, [join(app, 'installed', 'src', 'cli.js'), 'text', 'hello'], {
      cwd: root, encoding: 'utf8', timeout: 10_000, env: { ...process.env, NNA_HOME: data },
    }) : null;
    assert.notEqual(result.status, 0, `installer reported success; launch status=${launch?.status}, stderr=${launch?.stderr}`);
    assert.match(unwrapHostOutput(`${result.stdout}\n${result.stderr}`), /Unsafe NNA user data manifest target \(manifest_target_unsafe helper=desktop_private_namespace_unsafe stage=manifest_file\)[\s\S]*manifest\.json/u);
    assert.equal(existsSync(app), false, 'unsafe manifest must stop installation before payload mutation');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows installer rejects unsafe existing startup manifest storage before replacing the application', {
  skip: process.platform !== 'win32', timeout: 30_000,
}, async () => {
  const root = createScratchSync('nna-unsafe-manifest-storage-');
  const app = join(root, 'app');
  const data = join(root, 'home', '.nna');
  const manifest = join(data, 'config', 'manifest.json');
  try {
    await mkdir(join(data, 'config'), { recursive: true });
    const target = await manifestTarget(manifest);
    const grant = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
      $ErrorActionPreference = 'Stop'
      $path = [Console]::In.ReadToEnd()
      $info = [IO.DirectoryInfo]::new($path)
      $acl = $info.GetAccessControl()
      $rule = [Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new('S-1-1-0'),
        [Security.AccessControl.FileSystemRights]::Modify,
        [Security.AccessControl.AccessControlType]::Allow)
      $acl.AddAccessRule($rule)
      $info.SetAccessControl($acl)
    `], { input: target.storage, encoding: 'utf8', timeout: 5000 });
    assert.equal(grant.status, 0, grant.stderr);
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(projectRoot, 'install.ps1'),
      '-SourceRoot', projectRoot, '-InstallRoot', app, '-DataRoot', data,
      '-SkipPathUpdate', '-SkipDependencyInstall', '-SkipRipgrepSetup', '-SkipProviderSetup',
      '-SkipPlaywrightSetup', '-SkipGatewaySetup',
    ], { cwd: root, encoding: 'utf8', timeout: 20_000 });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(unwrapHostOutput(`${result.stdout}\n${result.stderr}`), /Unsafe NNA user data manifest target \(manifest_target_unsafe helper=desktop_private_acl_unsafe stage=storage_directory\)[\s\S]*manifest\.json/u);
    assert.equal(existsSync(app), false, 'unsafe manifest storage must stop installation before payload mutation');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows installer retries an unavailable manifest check once before payload staging', {
  skip: process.platform !== 'win32', timeout: 30_000,
}, async () => {
  const root = createScratchSync('nna-manifest-check-retry-');
  const source = join(root, 'source');
  const counter = join(root, 'manifest-check-count');
  const app = join(root, 'app');
  const data = join(root, 'home', '.nna');
  try {
    await mkdir(join(source, 'src', 'persistence'), { recursive: true });
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'not-native-agent', nna_version: VERSION, type: 'module' }));
    await writeFile(join(source, 'src', 'persistence', 'manifest-files.js'), `
      import { readFile, writeFile } from 'node:fs/promises';
      export async function manifestTarget() {
        const count = Number(await readFile(${JSON.stringify(counter)}, 'utf8').catch(() => '0')) + 1;
        await writeFile(${JSON.stringify(counter)}, String(count));
        if (count === 1) { const error = new Error('helper unavailable'); error.code = 'manifest_target_unavailable'; throw error; }
      }
    `);
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(projectRoot, 'install.ps1'),
      '-SourceRoot', source, '-InstallRoot', app, '-DataRoot', data,
      '-SkipPathUpdate', '-SkipDependencyInstall', '-SkipRipgrepSetup', '-SkipProviderSetup',
      '-SkipPlaywrightSetup', '-SkipGatewaySetup',
    ], { cwd: root, encoding: 'utf8', timeout: 20_000 });
    assert.equal(await readFile(counter, 'utf8'), '2', result.stderr);
    assert.match(result.stdout, /Application payload/u);
    assert.doesNotMatch(unwrapHostOutput(`${result.stdout}\n${result.stderr}`), /Unsafe NNA user data manifest|manifest check unavailable/u);
    assert.notEqual(result.status, 0, 'the minimal test source intentionally has no installable payload');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('AC-PROD-05 installation, primary, and headless guidance disclose operator responsibility', async () => {
  for (const path of ['README.md', 'docs/INSTALLATION.md', 'docs/HEADLESS.md']) {
    const source = await readFile(join(projectRoot, path), 'utf8');
    assert.match(source, /responsib/iu, path);
    assert.match(source, /not (?:a )?guarantee|not guarantees|are not guarantees/iu, path);
    assert.match(source, /reviewer approval[\s\S]{0,120}not proof|approval is not proof/iu, path);
    assert.match(source, /Apache License 2\.0|Apache-2\.0/iu, path);
    assert.match(source, /warranty/iu, path);
    assert.match(source, /liabilit/iu, path);
  }
});

test('AC-DEP-02 distribution metadata uses Apache-2.0 and the standard license text', async () => {
  const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  const license = await readFile(join(projectRoot, 'LICENSE'), 'utf8');
  const notice = await readFile(join(projectRoot, 'NOTICE'), 'utf8');
  assert.equal(packageJson.license, 'Apache-2.0');
  assert.match(license, /^\s*Apache License\s+Version 2\.0, January 2004/iu);
  assert.match(license, /TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION/iu);
  assert.match(license, /END OF TERMS AND CONDITIONS/iu);
  assert.match(license, /APPENDIX: How to apply the Apache License to your work/iu);
  assert.match(notice, /NotNativeAgent/u);
});

test('AC-DEP-01 SBOM and third-party notices retain dependency transparency', async () => {
  const sbom = JSON.parse(await readFile(join(projectRoot, 'SBOM.spdx.json'), 'utf8'));
  const notices = await readFile(join(projectRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  const gate = await readFile(join(projectRoot, 'scripts', 'release-gates.js'), 'utf8');
  assert.equal(sbom.spdxVersion, 'SPDX-2.3');
  assert.match(gate, /SBOM format is invalid/u);
  assert.match(gate, /release artifact mismatch/u);
  assert.match(gate, /third-party notice is missing for SBOM dependency/u);
  assert.match(gate, /SearXNG checksum is missing from SBOM/u);
  for (const dependency of sbom.packages.filter((item) => item.name !== 'not-native-agent')) {
    assert.match(notices, new RegExp(dependency.name, 'u'));
  }
  const searxng = sbom.packages.find((item) => item.name === 'SearXNG');
  assert.match(searxng.checksums[0].checksumValue, /^[0-9a-f]{64}$/u);
});

test('AC-IMPLP-01/AC-IMPLP-02 automated source and implementation safety gates pass', async () => {
  const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  // Scoped + serial glob keeps the bare runner inside test/ even with the bundled
  // desktop/ subtree, and keeps the process-table census tests deterministic.
  assert.match(packageJson.scripts.check, /^node scripts\/quality-gates\.js && node --test --test-concurrency=1 "test\/\*\.test\.js"$/u);
  const checked = spawnSync(process.execPath, [join(projectRoot, 'scripts', 'quality-gates.js')], {
    cwd: projectRoot, encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /quality gates passed/u);
});

test('AC-PERF-01/AC-PERF-02/AC-PERF-05/AC-PERF-06 performance lab emits every required measurement family', () => {
  const result = spawnSync(process.execPath, [join(projectRoot, 'scripts', 'performance-lab.js'), '--quick'], {
    cwd: tmpdir(), encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.parameters.quick, true);
  assert.ok(report.help_startup_ms.p95 >= 0);
  assert.ok(report.engine_initialization_ms.p95 >= 0);
  assert.ok(report.first_frame_ms.p95 >= 0);
  assert.equal(report.stream_projection.events, 2_000);
  assert.equal(report.stream_projection.retained_records, 512);
  assert.equal(report.observer_queue.events, 256);
  assert.ok(report.detector_and_context.visible_tool_schema_bytes > 0);
  assert.equal(report.resource_soak.turns, 5);
});

test('resource soak rejects failed teardown instead of reporting a completed measurement', async () => {
  const failure = new Error('fixture shutdown failed');
  const calls = [];
  await assert.rejects(runSoakTurns(2, (index) => ({
    async initialize() { calls.push(`initialize-${index}`); },
    async submit() { calls.push(`submit-${index}`); return { outcome: 'completed' }; },
    async shutdown() { calls.push(`shutdown-${index}`); throw failure; },
  })), failure);
  assert.deepEqual(calls, ['initialize-0', 'submit-0', 'shutdown-0']);
});

test('resource soak rejects an unsuccessful turn after cleaning up its engine', async () => {
  const calls = [];
  await assert.rejects(runSoakTurns(2, (index) => ({
    async initialize() { calls.push(`initialize-${index}`); },
    async submit() { calls.push(`submit-${index}`); return { outcome: 'failed' }; },
    async shutdown() { calls.push(`shutdown-${index}`); },
  })), /resource soak turn 0 ended failed/u);
  assert.deepEqual(calls, ['initialize-0', 'submit-0', 'shutdown-0']);
});

test('resource soak retains both turn and teardown failures', async () => {
  const turnFailure = new Error('turn failed');
  const shutdownFailure = new Error('shutdown failed');
  await assert.rejects(runSoakTurns(1, () => ({
    async initialize() {},
    async submit() { throw turnFailure; },
    async shutdown() { throw shutdownFailure; },
  })), (error) => error instanceof AggregateError
    && error.errors[0] === turnFailure && error.errors[1] === shutdownFailure);
});

test('release sealing excludes gitignored development artifacts', async () => {
  const source = await readFile(join(process.cwd(), 'scripts', 'release-gates.js'), 'utf8');
  assert.match(source, /'docs\/planning\/'/u);
  assert.match(source, /'\.tmp-npm-cache\/'/u);
  assert.match(source, /'\.npm-cache\/'/u);
  assert.match(source, /RELEASE_INCLUDED_ROOT_FILES/u);
  assert.match(source, /RELEASE_INCLUDED_PREFIXES/u);
  assert.match(source, /releaseEligible\(path\)/u);
  assert.doesNotMatch(source, /writeHashes[\s\S]*collect\(root\)\)\.filter\(\(path\) => !path\.endsWith/u);
  assert.match(source, /native \$\{platform\} conformance evidence is missing/u);
  assert.match(source, /platform evidence version disagrees/u);
  assert.doesNotMatch(source, /verifyBaseline|human release approvals/u);
});

test('npm publication uses an explicit product allowlist', async () => {
  const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  assert.ok(Array.isArray(manifest.files));
  assert.ok(manifest.files.includes('src/'));
  assert.ok(manifest.files.includes('docs/'));
  assert.ok(manifest.files.includes('!docs/planning/'));
  assert.equal(manifest.files.some((path) => !path.startsWith('!') && /planning|\.tmp|\.github/iu.test(path)), false);
  assert.equal(manifest.scripts.prepublishOnly, 'node scripts/release-gates.js');
});

test('installed CLI state follows NNA_HOME instead of the launch directory', async () => {
  const root = createScratchSync('nna-cli-home-');
  const launch = join(root, 'launch');
  const data = join(root, 'data');
  await mkdir(launch);
  await ensureUserDataPaths(userDataPaths({ home: root, environment: { NNA_HOME: data } }));
  try {
    const commands = [
      JSON.stringify({
        version: '1.0', type: 'initialize', request_id: 'portable-init', session_id: 'portable-session',
        manifest: { provider: { id: 'local', endpoint: 'http://127.0.0.1:9/v1', model: 'unused', trust_zone: 'loopback' } },
      }),
      JSON.stringify({ version: '1.0', type: 'shutdown', request_id: 'portable-stop' }),
    ].join('\n');
    const result = spawnSync(process.execPath, [join(projectRoot, 'src', 'cli.js'), 'headless'], {
      cwd: launch, input: `${commands}\n`, encoding: 'utf8', env: { ...process.env, NNA_HOME: data },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(data, 'sessions', 'portable-session.journal.ndjson')), true);
    assert.equal(existsSync(join(launch, '.nna')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native per-user installer launches the packaged CLI and refuses noninteractive self-removal', {
  skip: !['win32', 'linux', 'darwin'].includes(process.platform), timeout: 30_000,
}, async () => {
  const root = createScratchSync('nna-native-install-');
  const app = join(root, 'app');
  const data = join(root, 'home', '.nna');
  try {
    const result = process.platform === 'win32'
      ? windowsSmoke(root, app, data)
      : linuxSmoke(root, app, data);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, new RegExp(VERSION.replaceAll('.', '\\.')));
    assert.match(result.stdout, /NNA \/\/ INSTALLER/u);
    assert.match(result.stdout, /Runtime readiness/u);
    assert.match(result.stdout, /Verification/u);
    assert.match(result.stdout, /INSTALL COMPLETE/u);
    assert.doesNotMatch(result.stdout, /\u001b/u);
    assert.doesNotMatch(result.stderr, /ExperimentalWarning/u);
    assert.equal(existsSync(app), true);
    assert.equal(existsSync(data), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function windowsSmoke(root, app, data) {
  const install = join(projectRoot, 'install.ps1');
  const uninstall = join(projectRoot, 'uninstall.ps1');
  const force = process.env.NNA_TEST_DEPENDENCY_BOOTSTRAP === '1' ? ' -ForceBundledNode' : '';
  const command = [
    `& '${install}' -SourceRoot '${projectRoot}' -InstallRoot '${app}' -DataRoot '${data}' -SkipPathUpdate${force}`,
    `if (-not ((Get-Content -LiteralPath '${join(data, '.nna-install.json')}' -Raw | ConvertFrom-Json).deletable)) { throw 'fresh data root lost installer ownership' }`,
    `Set-Content -LiteralPath '${join(app, 'installed', 'stale.txt')}' -Value 'replace me'`,
    `New-Item -ItemType Directory -Force -Path '${join(app, 'runtime')}' | Out-Null`,
    `Set-Content -LiteralPath '${join(app, 'runtime', 'keep.txt')}' -Value 'runtime state'`,
    `Set-Content -LiteralPath '${join(app, 'transitory', 'keep.txt')}' -Value 'transitory state'`,
    `Set-Content -LiteralPath '${join(data, 'keep.txt')}' -Value 'user state'`,
    `& '${install}' -SourceRoot '${projectRoot}' -InstallRoot '${app}' -DataRoot '${data}' -SkipPathUpdate`,
    `if (Test-Path -LiteralPath '${join(app, 'installed', 'stale.txt')}') { throw 'stale installed payload survived overwrite' }`,
    `if (-not (Test-Path -LiteralPath '${join(app, 'runtime', 'keep.txt')}')) { throw 'runtime data was removed' }`,
    `if (-not (Test-Path -LiteralPath '${join(app, 'transitory', 'keep.txt')}')) { throw 'transitory data was removed' }`,
    `if (-not (Test-Path -LiteralPath '${join(data, 'keep.txt')}')) { throw 'user data was removed' }`,
    `& '${join(app, 'bin', 'nna.cmd')}' --version`,
    `& '${join(app, 'bin', 'nna.ps1')}' --version`,
    `$env:Path = '${join(app, 'bin')};' + $env:Path`,
    `if ((Get-Command nna -CommandType ExternalScript).Name -ne 'nna.ps1') { throw 'PowerShell did not prefer the non-batch launcher' }`,
    `$UninstallBlocked = $false`,
    `try { & '${uninstall}' -InstallRoot '${app}' -DeleteUserData -SkipPathUpdate } catch { $UninstallBlocked = $true }`,
    `if (-not $UninstallBlocked) { throw 'noninteractive uninstall was not blocked' }`,
    `if (-not (Test-Path -LiteralPath '${app}')) { throw 'application was removed without human confirmation' }`,
    `if (-not (Test-Path -LiteralPath '${data}')) { throw 'user data was removed without human confirmation' }`,
  ].join('; ');
  return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    cwd: root, encoding: 'utf8', timeout: 25_000,
  });
}

function linuxSmoke(root, app, data) {
  const environment = {
    ...process.env, HOME: join(root, 'home'), XDG_DATA_HOME: join(root, 'xdg'),
    NNA_FORCE_BUNDLED_NODE: process.env.NNA_TEST_DEPENDENCY_BOOTSTRAP ?? '0',
  };
  const install = join(projectRoot, 'install.sh');
  const uninstall = join(projectRoot, 'uninstall.sh');
  const script = [
    'sh "$1" --source "$2" --install-root "$3" --data-root "$4"',
    'printf stale > "$3/installed/stale.txt"',
    'mkdir -p "$3/runtime"',
    'printf runtime > "$3/runtime/keep.txt"',
    'printf transitory > "$3/transitory/keep.txt"',
    'printf user > "$4/keep.txt"',
    'NNA_FORCE_BUNDLED_NODE=0 sh "$1" --source "$2" --install-root "$3" --data-root "$4"',
    'test ! -e "$3/installed/stale.txt"',
    'test -e "$3/runtime/keep.txt"',
    'test -e "$3/transitory/keep.txt"',
    'test -e "$4/keep.txt"',
    '"$HOME/.local/bin/nna" --version',
    'if sh "$5" --install-root "$3" --delete-user-data; then exit 1; fi',
    'test -e "$3"',
    'test -e "$4"',
  ].join(' && ');
  return spawnSync('sh', ['-c', script, 'nna-test', install, projectRoot, app, data, uninstall], {
    cwd: root, encoding: 'utf8', timeout: 25_000, env: environment,
  });
}
