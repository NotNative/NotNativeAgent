// SPDX-License-Identifier: Apache-2.0
/**
 * P12a packaging pipeline (NOTES/09 §A.4, doc 09 §14.1/14.2 win-x64 subset).
 *
 * 1. web UI production build via packages/web's own vite CLI (retry once
 *    after 30 s: a transient design-system.css failure usually means an
 *    auditor is mid-proof in packages/web/src/index.css in parallel).
 * 2. stage packages/web/dist -> packages/electron/resources/web-dist.
 * 3. esbuild-bundle the server: packages/web/src/server/index.ts ->
 *    packages/electron/dist-server/server.mjs. ALL deps bundle except the
 *    native boundary (node-pty stays external; D-09-5). Stage and verify
 *    node-pty beside the bundle. A leak of @notnative/ui fails the build.
 * 4. electron-builder win nsis oneClick (unsigned; version rides in via
 *    -c.extraMetadata.version from the root package.json — D-09-12).
 *
 * Preflight: the electron binary must be unpacked (Node 24 can leave
 * electron's postinstall half-done); missing -> ELECTRON_BINARY_UNREACHABLE.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { build as esbuild } from 'esbuild';

const ROOT = directoryPathFromModuleUrl(new URL('../', import.meta.url));
const WEB_DIR = path.join(ROOT, 'packages', 'web');
const SHELL_DIR = path.join(ROOT, 'packages', 'electron');
const STAGED_DIST = path.join(SHELL_DIR, 'resources', 'web-dist');
const BUNDLE_OUT = path.join(SHELL_DIR, 'dist-server', 'server.mjs');
const NATIVE_RUNTIME_DIR = path.join(SHELL_DIR, 'dist-server', 'node_modules', 'node-pty');
const OUTPUT_DIR = path.join(ROOT, 'dist-electron');
const NATIVE_EXTERNALS = ['node-pty'];
const WINDOWS_PTY_FILES = ['pty.node', 'conpty.node', 'conpty_console_list.node', 'winpty-agent.exe',
  'winpty.dll', path.join('conpty', 'conpty.dll'), path.join('conpty', 'OpenConsole.exe')];
// electron-builder may Authenticode-sign these executable helpers while
// copying extraResources; their bytes need not match the unsigned staged files.
const SIGNED_PTY_HELPERS = new Set(['winpty-agent.exe', 'conpty/OpenConsole.exe']
  .map((file) => `node_modules/node-pty/prebuilds/win32-x64/${file}`));
// Data files the server bundle reads relative to import.meta.url — esbuild
// copies no JSON siblings, so the pipeline must stage them next to the bundle.
const SIBLING_DATA = [path.join('packages', 'web', 'src', 'server', 'lib', 'settings-registry.json')];

const NO_NSIS = process.argv.includes('--no-nsis'); // script-install mode: build shell artifacts only

main().catch((error) => {
  process.stderr.write(`electron-package failed: ${error?.stack ?? error}\n`);
  process.exitCode = 1;
});

async function main() {
  const version = readRootVersion();
  log(`packaging NotNativeDesktop ${version} (win-x64,${NO_NSIS ? ' artifacts only' : ' unsigned NSIS'})`);
  ensureElectronBinary();
  generateTrayIcons();
  buildWebUi();
  // resources/web-dist exists ONLY for the NSIS pipeline (electron-builder
  // files 'resources/**' + extraResources). The artifacts-only install serves
  // straight from packages/web/dist (main.mjs resolveDistDir unpackaged arm),
  // so a staged copy is dead weight there - skip it instead of shipping MiBs
  // the runtime never reads (P12b-1 audit).
  if (NO_NSIS) {
    log('artifacts-only mode: resources/web-dist staging skipped (serves packages/web/dist)');
  } else {
    stageWebDist();
  }
  await bundleServer();
  copySiblingData();
  stageNativeRuntime();
  verifyNativeRuntime();
  if (NO_NSIS) {
    reportArtifactIntegrity();
    log('artifacts ready (electron/, no installer pass)');
    return;
  }
  const installer = installerPath(version);
  const previousInstaller = existsSync(installer) ? statSync(installer) : null;
  runElectronBuilder(version);
  reportArtifacts(installer, previousInstaller);
  runPackagedTerminalSmoke();
}

// ── step 0: root version + electron binary preflight ────────────────────────

function readRootVersion() {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) throw new Error('root package.json lacks version');
  return manifest.version;
}

function electronDir() {
  return path.join(SHELL_DIR, 'node_modules', 'electron');
}

function electronBinaryPath() {
  return path.join(electronDir(), 'dist', 'electron.exe');
}

function ensureElectronBinary() {
  if (existsSync(electronBinaryPath())) { log(`electron binary ok: ${electronBinaryPath()}`); return; }
  log('electron dist/electron.exe missing — re-running electron install.js (Node 24 postinstall repair)');
  const repair = spawnSync(process.execPath, [path.join(electronDir(), 'install.js')], {
    cwd: electronDir(), stdio: 'inherit', env: process.env,
  });
  if (repair.status !== 0) failBinaryUnreachable(`install.js exited ${repair.status}`);
  if (!existsSync(electronBinaryPath())) failBinaryUnreachable('electron.exe still absent after install.js');
  const probe = spawnSync(electronBinaryPath(), ['--version'], { stdio: 'pipe', encoding: 'utf8' });
  if (probe.status !== 0) failBinaryUnreachable(`electron.exe --version exited ${probe.status}`);
  log(`electron binary repaired; version ${(probe.stdout ?? '').trim()}`);
}

function failBinaryUnreachable(detail) {
  throw new Error(`ELECTRON_BINARY_UNREACHABLE: ${detail}`);
}

/** Tray status icons (pure-Node PNG encoder, no deps) — tray fails soft without them. */
function generateTrayIcons() {
  const script = path.join(ROOT, 'scripts', 'electron-tray-icon.mjs');
  if (!existsSync(script)) throw new Error(`tray icon generator missing at ${script}`);
  const result = spawnSync(process.execPath, [script], { cwd: ROOT, stdio: 'inherit', env: process.env });
  if (result.status !== 0) throw new Error(`tray icon generation exited ${result.status}`);
  log(`tray icons ok: ${path.join(SHELL_DIR, 'assets')}`);
}

// ── step 1: vite build (web package's own CLI, cwd-relative outDir) ────────

function viteCliPath() {
  return path.join(WEB_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
}

function buildWebUi() {
  if (!existsSync(viteCliPath())) throw new Error(`vite CLI missing at ${viteCliPath()}`);
  let attempt = runViteBuild(1);
  if (attempt.status !== 0) {
    log(`vite build failed (exit ${attempt.status}); retrying once after 30 s (parallel auditor in index.css is a known transient)`);
    sleepSeconds(30);
    attempt = runViteBuild(2);
  }
  if (attempt.status !== 0) throw new Error(`vite build failed twice (last exit ${attempt.status})`);
  log('vite build green');
}

function runViteBuild(attempt) {
  log(`vite build attempt ${attempt} (cwd ${WEB_DIR})`);
  return spawnSync(process.execPath, [viteCliPath(), 'build'], { cwd: WEB_DIR, stdio: 'inherit' });
}

function sleepSeconds(seconds) {
  spawnSync(process.execPath, ['-e', `setTimeout(() => {}, ${seconds * 1000})`], { stdio: 'ignore' });
}

// ── step 2: stage dist -> resources/web-dist (clean first) ─────────────────

function stageWebDist() {
  const source = path.join(WEB_DIR, 'dist');
  if (!existsSync(path.join(source, 'index.html'))) throw new Error(`no built UI at ${source} (vite output missing)`);
  rmSync(STAGED_DIST, { recursive: true, force: true, maxRetries: 4 });
  cpSync(source, STAGED_DIST, { recursive: true });
  log(`staged web-dist: ${countFiles(STAGED_DIST)} files`);
}

function countFiles(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    total += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1;
  }
  return total;
}

// ── step 3: esbuild bundle (deps bundled; node-pty the only external) ─────

async function bundleServer() {
  const entry = path.join(WEB_DIR, 'src', 'server', 'index.ts');
  log(`bundling server ${entry}`);
  await esbuild({
    entryPoints: [entry],
    outfile: BUNDLE_OUT,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: NATIVE_EXTERNALS,
    banner: {
      // CJS deps (ws and friends) require() Node builtins; an ESM bundle has
      // no require, so bind one to this file (standard esbuild interop shim).
      js: "import { createRequire as __nndCreateRequire } from 'node:module'; const require = __nndCreateRequire(import.meta.url);",
    },
    logLevel: 'warning',
  });
  auditBundle(readFileSync(BUNDLE_OUT, 'utf8'));
}

function copySiblingData() {
  for (const rel of SIBLING_DATA) {
    const source = path.join(ROOT, rel);
    const target = path.join(SHELL_DIR, 'dist-server', path.basename(rel));
    if (!existsSync(source)) throw new Error(`sibling data missing: ${rel}`);
    cpSync(source, target);
    log(`staged sibling data: ${path.basename(rel)}`);
  }
}

function stageNativeRuntime() {
  const source = path.join(WEB_DIR, 'node_modules', 'node-pty');
  const variant = `${process.platform}-${NO_NSIS ? process.arch : 'x64'}`;
  const prebuilt = path.join(source, 'prebuilds', variant);
  const compiled = path.join(source, 'build', 'Release');
  const nativeSource = existsSync(path.join(prebuilt, 'pty.node')) ? prebuilt : compiled;
  const required = process.platform === 'win32' ? WINDOWS_PTY_FILES : ['pty.node', 'spawn-helper'];
  const missing = [path.join(source, 'lib', 'index.js'), path.join(source, 'package.json'), path.join(source, 'LICENSE'),
    ...required.map((file) => path.join(nativeSource, file))].filter((file) => !existsSync(file));
  if (missing.length > 0) throw new Error(`node-pty runtime is incomplete for ${variant}: ${missing.join(', ')}`);
  // Invariant: only replace the fixed, generated native package beneath dist-server.
  if (path.dirname(NATIVE_RUNTIME_DIR) !== path.join(SHELL_DIR, 'dist-server', 'node_modules')) {
    throw new Error('native staging target escaped dist-server');
  }
  rmSync(NATIVE_RUNTIME_DIR, { recursive: true, force: true, maxRetries: 4 });
  mkdirSync(NATIVE_RUNTIME_DIR, { recursive: true });
  cpSync(path.join(source, 'package.json'), path.join(NATIVE_RUNTIME_DIR, 'package.json'));
  cpSync(path.join(source, 'LICENSE'), path.join(NATIVE_RUNTIME_DIR, 'LICENSE'));
  cpSync(path.join(source, 'lib'), path.join(NATIVE_RUNTIME_DIR, 'lib'), { recursive: true });
  const nativeTarget = nativeSource === prebuilt
    ? path.join(NATIVE_RUNTIME_DIR, 'prebuilds', variant) : path.join(NATIVE_RUNTIME_DIR, 'build', 'Release');
  cpSync(nativeSource, nativeTarget, { recursive: true,
    filter: (name) => !name.toLowerCase().endsWith('.pdb') });
  log(`staged node-pty runtime: ${variant} (${countFiles(NATIVE_RUNTIME_DIR)} files)`);
}

function verifyNativeRuntime() {
  const variant = `${process.platform}-${NO_NSIS ? process.arch : 'x64'}`;
  const prebuilt = path.join(NATIVE_RUNTIME_DIR, 'prebuilds', variant);
  const nativeDir = existsSync(path.join(prebuilt, 'pty.node'))
    ? prebuilt : path.join(NATIVE_RUNTIME_DIR, 'build', 'Release');
  const addonNames = process.platform === 'win32' ? ['pty', 'conpty', 'conpty_console_list'] : ['pty'];
  const probe = [
    "const { createRequire } = require('node:module');",
    `const pty = createRequire(${JSON.stringify(BUNDLE_OUT)})('node-pty');`,
    `for (const name of ${JSON.stringify(addonNames)}) require(${JSON.stringify(nativeDir)} + '/' + name + '.node');`,
    "if (typeof pty.spawn !== 'function') process.exitCode = 1;",
  ].join('\n');
  for (const [runtime, env] of [[process.execPath, process.env], [electronBinaryPath(), { ...process.env, ELECTRON_RUN_AS_NODE: '1' }]]) {
    const result = spawnSync(runtime, ['-e', probe], { cwd: ROOT, env, encoding: 'utf8', timeout: 5_000,
      maxBuffer: 262_144 });
    if (result.status !== 0 || result.error) {
      throw new Error(`staged node-pty failed in ${runtime}: ${result.error?.code ?? result.status}; stdout=${result.stdout?.slice(-400) ?? ''}; stderr=${result.stderr?.slice(-400) ?? ''}`);
    }
  }
  log('staged node-pty and native addons loaded in Node and Electron runtimes');
}

function auditBundle(text) {
  if (text.includes('@notnative/ui/')) {
    throw new Error('bundle leak: the server bundle pulls @notnative/ui code (React would ride along) — treat as failure');
  }
  if (!text.includes("'node-pty'") && !text.includes('"node-pty"')) {
    throw new Error('bundle audit: node-pty require target absent — the native boundary was inlined or lost');
  }
  if (!text.includes('__nndCreateRequire')) {
    throw new Error('bundle audit: createRequire banner absent — CJS deps would die at import with Dynamic-require-unsupported');
  }
  const size = statSync(BUNDLE_OUT).size;
  log(`server bundle ok: ${(size / 1024 / 1024).toFixed(2)} MiB (node-pty external)`);
}

// ── step 4: electron-builder win nsis (unsigned) ────────────────────────────

function builderCliPath() {
  return path.join(SHELL_DIR, 'node_modules', 'electron-builder', 'cli.js');
}

function runElectronBuilder(version) {
  if (!existsSync(builderCliPath())) throw new Error(`electron-builder CLI missing at ${builderCliPath()}`);
  const args = ['--win', 'nsis', '--x64', `-c.extraMetadata.version=${version}`];
  log(`electron-builder ${args.join(' ')}`);
  const result = spawnSync(process.execPath, [builderCliPath(), ...args], {
    cwd: SHELL_DIR,
    stdio: 'inherit',
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  });
  if (result.status !== 0) throw new Error(`electron-builder exited ${result.status}`);
}

// ── report ────────────────────────────────────────────────────────────────

function installerPath(version) {
  return path.join(OUTPUT_DIR, `NotNativeDesktop-Setup-${version}-win-x64.exe`);
}

function reportArtifacts(setup, previousInstaller) {
  if (!existsSync(setup)) throw new Error(`current-version installer missing: ${setup}`);
  const stagedServer = path.join(SHELL_DIR, 'dist-server');
  const packagedServer = path.join(OUTPUT_DIR, 'win-unpacked', 'resources', 'dist-server');
  if (!existsSync(packagedServer)) throw new Error(`installer omitted server runtime: ${packagedServer}`);
  const stagedDigest = directoryDigest(stagedServer, SIGNED_PTY_HELPERS);
  const packagedDigest = directoryDigest(packagedServer, SIGNED_PTY_HELPERS);
  if (stagedDigest.files !== packagedDigest.files || stagedDigest.digest !== packagedDigest.digest) {
    throw new Error(`packaged server runtime differs from staged artifacts: ${packagedServer}`);
  }
  const currentInstaller = statSync(setup);
  if (previousInstaller && currentInstaller.mtimeMs === previousInstaller.mtimeMs
    && currentInstaller.size === previousInstaller.size) {
    throw new Error(`installer was not refreshed by electron-builder: ${setup}`);
  }
  const sha256 = createHash('sha256').update(readFileSync(setup)).digest('hex');
  log(`installer: ${path.basename(setup)} (${(currentInstaller.size / 1024 / 1024).toFixed(1)} MiB)`);
  log(`sha256:  ${sha256}`);
}

function runPackagedTerminalSmoke() {
  const smoke = path.join(ROOT, 'scripts', 'electron-terminal-smoke.mjs');
  const result = spawnSync(process.execPath, [smoke], {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: 15_000,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`packaged terminal smoke failed: ${result.error?.message ?? result.status}`);
  }
}

// ── artifacts-only integrity oracle (--no-nsis) ─────────────────────────────
// The NSIS path prints the installer sha256; this mode ships no installer, so
// the runnable artifact set needs its own verifiable print: server bundle +
// staged sibling data + tray assets + the web dist tree the shell serves (a
// missing artifact fails here instead of booting into a half-built install).

function sha256Hex(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Deterministic tree digest: pre-sorted relative paths, rolling sha chain. */
function directoryDigest(dir, signedExecutables = new Set()) {
  const rows = [];
  const walk = (current) => {
    const entries = readdirSync(current, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const relative = path.relative(dir, full).replaceAll('\\', '/');
        if (signedExecutables.has(relative)) {
          if (statSync(full).size === 0) throw new Error(`empty packaged executable: ${full}`);
          rows.push(`${relative} signed-executable`);
        } else rows.push(`${relative} ${sha256Hex(full)}`);
      }
    }
  };
  walk(dir);
  return { files: rows.length, digest: createHash('sha256').update(rows.join('\n')).digest('hex') };
}

function reportArtifactIntegrity() {
  const bundle = path.join(SHELL_DIR, 'dist-server', 'server.mjs');
  const registry = path.join(SHELL_DIR, 'dist-server', 'settings-registry.json');
  const webDist = path.join(WEB_DIR, 'dist');
  const trayDir = path.join(SHELL_DIR, 'assets');
  const trayIcons = [path.join(trayDir, 'tray-running.png'), path.join(trayDir, 'tray-stopped.png')];
  const missing = [bundle, registry, webDist, NATIVE_RUNTIME_DIR, ...trayIcons].filter((artifact) => !existsSync(artifact));
  if (missing.length > 0) throw new Error(`artifact integrity check incomplete, missing: ${missing.join(', ')}`);
  for (const artifact of [bundle, registry, ...trayIcons]) {
    log(`sha256 ${path.relative(ROOT, artifact).replaceAll('\\', '/')}: ${sha256Hex(artifact)}`);
  }
  const web = directoryDigest(webDist);
  log(`sha256 web-dist tree (packages/web/dist, ${web.files} files, sorted rel-path digest): ${web.digest}`);
  const native = directoryDigest(NATIVE_RUNTIME_DIR);
  log(`sha256 native-runtime tree (node-pty, ${native.files} files, sorted rel-path digest): ${native.digest}`);
}

function log(line) {
  process.stdout.write(`[electron-package] ${line}\n`);
}

function directoryPathFromModuleUrl(url) {
  let pathname = new URL(url).pathname;
  try { pathname = decodeURIComponent(pathname); } catch { /* raw pathname is still usable */ }
  if (process.platform === "win32" && /^\/[a-zA-Z]:/u.test(pathname)) pathname = pathname.slice(1);
  return pathname.replace(/[\\/]$/u, '');
}
