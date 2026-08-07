// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { ensureUserDataPaths, userDataPaths, VERSION } from '../src/product.js';
import { parseCli } from '../src/cli-options.js';
import { discoverLocalProvider, loadStartupManifest } from '../src/onboarding.js';
import { runUninstallCommand } from '../src/uninstall-cli.js';

const projectRoot = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/u, (value) => value.slice(1))), '..');

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
  assert.deepEqual(parseCli(['-p', 'hello']), {
    mode: 'text', manifestPath: null, sessionId: null, prompt: ['hello'], providerProfile: null,
    providerEndpoint: null, model: null, providerCredentialEnv: null,
  });
  assert.deepEqual(parseCli(['--config', 'purpose.json', '-p']), {
    mode: 'text', manifestPath: 'purpose.json', sessionId: null, prompt: [], providerProfile: null,
    providerEndpoint: null, model: null, providerCredentialEnv: null,
  });
  assert.equal(parseCli(['host']).mode, 'headless');
  assert.equal(parseCli(['headless']).mode, 'headless');
  assert.equal(parseCli(['--config', 'interactive.json']).mode, 'tui');
  assert.equal(parseCli(['gateway', 'status']).mode, 'gateway');
  assert.deepEqual(parseCli(['gateway', 'status']).prompt, ['status']);
  assert.deepEqual(parseCli(['secrets', 'serve']).prompt, ['serve']);
  assert.deepEqual(parseCli(['webbrowse', 'status']).prompt, ['status']);
  assert.equal(parseCli(['uninstall']).mode, 'uninstall');
  assert.deepEqual(parseCli(['uninstall', '--delete-user-data']).prompt, ['--delete-user-data']);
  assert.deepEqual(parseCli(['uninstall', '--keep-user-data']).prompt, ['--keep-user-data']);
  const override = parseCli(['--provider-profile', 'remote', '--model', 'qwen', '-p', 'hello']);
  assert.equal(override.providerProfile, 'remote');
  assert.equal(override.model, 'qwen');
  assert.deepEqual(override.prompt, ['hello']);
  assert.throws(() => parseCli(['--provider-credential-env', 'literal-secret!']), { code: 'credential_reference_invalid' });
  assert.throws(() => parseCli(['host', '--model', 'unsafe-override']), { code: 'host_override_requires_manifest' });
});

test('uninstall command rejects conflicting or unknown deletion choices before launch', async () => {
  await assert.rejects(runUninstallCommand(['--delete-user-data', '--keep-user-data']), { code: 'uninstall_option_conflict' });
  await assert.rejects(runUninstallCommand(['--force']), { code: 'uninstall_option_invalid' });
});

test('first run persists explicit environment configuration and reuses it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-onboarding-'));
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

test('AC-SESS-08 legacy configuration migrates once with backup and future formats fail safely', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-config-migration-'));
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
  const root = await mkdtemp(join(tmpdir(), 'nna-onboarding-required-'));
  const paths = userDataPaths({ home: root, environment: {} });
  await ensureUserDataPaths(paths);
  try {
    await assert.rejects(loadStartupManifest({
      paths, environment: {}, discover: async () => null, input: { isTTY: false }, output: { isTTY: false },
    }), { code: 'setup_required' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('version bump synchronizes canonical, runtime, package, and SBOM versions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-version-bump-'));
  try {
    await mkdir(join(root, 'scripts')); await mkdir(join(root, 'src'));
    for (const path of ['VERSION', 'package.json', 'SBOM.spdx.json']) {
      await copyFile(join(projectRoot, path), join(root, path));
    }
    await copyFile(join(projectRoot, 'src', 'product.js'), join(root, 'src', 'product.js'));
    await copyFile(join(projectRoot, 'scripts', 'bump-version.js'), join(root, 'scripts', 'bump-version.js'));
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'bump-version.js'), '--date', '20991231', '--iteration', '7'], {
      cwd: root, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await readFile(join(root, 'VERSION'), 'utf8')).trim(), '20991231-7');
    const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const sbom = JSON.parse(await readFile(join(root, 'SBOM.spdx.json'), 'utf8'));
    assert.equal(packageJson.version, '20991231.0.7');
    assert.equal(packageJson.nna_version, '20991231-7');
    assert.equal(sbom.packages[0].versionInfo, '20991231-7');
    assert.match(await readFile(join(root, 'src', 'product.js'), 'utf8'), /VERSION = '20991231-7'/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('product data paths are stable, home-scoped, and overrideable only absolutely', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-paths-'));
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
  assert.match(windowsInstall, /ForceBundledNode/u);
  assert.match(windowsInstall, /Join-Path \$InstallRoot 'installed'/u);
  assert.match(windowsInstall, /Join-Path \$BinRoot 'nna\.ps1'/u);
  assert.match(windowsInstall, /Join-Path \$InstallRoot 'uninstall\.ps1'/u);
  assert.match(windowsInstall, /\$PriorNnaHome/u);
  assert.match(windowsInstall, /SkipWebSearchSetup/u);
  assert.match(windowsInstall, /WebSearch is already configured/u);
  assert.match(windowsInstall, /SkipPlaywrightSetup/u);
  assert.match(windowsInstall, /Playwright Chromium v.*already installed; setup skipped/u);
  assert.match(windowsInstall, /webbrowse verify/u);
  assert.match(windowsInstall, /base URL of your existing SearXNG server/u);
  assert.match(windowsInstall, /Test-LegacyGatewayTask/u);
  assert.match(windowsInstall, /NotNativeAgentGateway/u);
  assert.match(windowsInstall, /Unregister-ScheduledTask/u);
  assert.match(windowsInstall, /-Verb RunAs/u);
  assert.match(windowsInstall, /does not target the legacy NNA gateway/u);
  assert.match(windowsInstall, /GatewayWasRunning/u);
  assert.match(windowsInstall, /Telegram gateway restarted on the updated runtime/u);
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
  assert.match(linuxInstall, /\$install_root\/uninstall\.sh/u);
  assert.match(linuxInstall, /--skip-websearch-setup/u);
  assert.match(linuxInstall, /WebSearch is already configured/u);
  assert.match(linuxInstall, /--skip-playwright-setup/u);
  assert.match(linuxInstall, /Playwright Chromium v.*already installed; setup skipped/u);
  assert.match(linuxInstall, /webbrowse verify/u);
  assert.match(linuxInstall, /base URL of your existing SearXNG server/u);
  assert.match(linuxInstall, /gateway_running/u);
  assert.match(linuxInstall, /systemctl --user restart notnativeagent-telegram\.service/u);
  assert.match(linuxInstall, /Telegram gateway restarted on the updated runtime/u);
  assert.match(unixUninstall, /Darwin/u);
  assert.match(unixUninstall, /Application Support\/NotNativeAgent/u);
  assert.match(unixUninstall, /--keep-user-data/u);
  assert.match(unixUninstall, /\[ -t 0 \] && \[ -t 1 \]/u);
  assert.match(unixUninstall, /UNINSTALL %s/u);
  assert.match(unixUninstall, /Permanently delete all NNA user data/u);
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
  assert.match(packageJson.scripts.check, /^node scripts\/quality-gates\.js && node --test$/u);
  const checked = spawnSync(process.execPath, [join(projectRoot, 'scripts', 'quality-gates.js')], {
    cwd: projectRoot, encoding: 'utf8', timeout: 20_000,
  });
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /quality gates passed/u);
});

test('AC-PERF-01/AC-PERF-02/AC-PERF-05/AC-PERF-06 performance lab emits every required measurement family', () => {
  const result = spawnSync(process.execPath, [join(projectRoot, 'scripts', 'performance-lab.js'), '--quick'], {
    cwd: projectRoot, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.parameters.quick, true);
  assert.ok(report.help_startup_ms.p95 >= 0);
  assert.ok(report.engine_initialization_ms.p95 >= 0);
  assert.ok(report.first_frame_ms.p95 >= 0);
  assert.equal(report.stream_projection.events, 2_000);
  assert.equal(report.observer_queue.events, 256);
  assert.ok(report.detector_and_context.visible_tool_schema_bytes > 0);
  assert.equal(report.resource_soak.turns, 5);
});

test('release sealing excludes gitignored development artifacts', async () => {
  const source = await readFile(join(process.cwd(), 'scripts', 'release-gates.js'), 'utf8');
  assert.match(source, /'docs\/planning\/'/u);
  assert.match(source, /'\.tmp-npm-cache\/'/u);
  assert.match(source, /'\.npm-cache\/'/u);
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
});

test('installed CLI state follows NNA_HOME instead of the launch directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-cli-home-'));
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
  const root = await mkdtemp(join(tmpdir(), 'nna-native-install-'));
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
