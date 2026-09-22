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
 *    native boundary (node-pty stays external; D-09-5). A leak of
 *    @notnative/ui into the bundle is treated as a hard failure.
 * 4. electron-builder win nsis oneClick (unsigned; version rides in via
 *    -c.extraMetadata.version from the root package.json — D-09-12).
 *
 * Preflight: the electron binary must be unpacked (Node 24 can leave
 * electron's postinstall half-done); missing -> ELECTRON_BINARY_UNREACHABLE.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { build as esbuild } from 'esbuild';

const ROOT = directoryPathFromModuleUrl(new URL('../', import.meta.url));
const WEB_DIR = path.join(ROOT, 'packages', 'web');
const SHELL_DIR = path.join(ROOT, 'packages', 'electron');
const STAGED_DIST = path.join(SHELL_DIR, 'resources', 'web-dist');
const BUNDLE_OUT = path.join(SHELL_DIR, 'dist-server', 'server.mjs');
const OUTPUT_DIR = path.join(ROOT, 'dist-electron');
const NATIVE_EXTERNALS = ['node-pty'];
// Data files the server bundle reads relative to import.meta.url — esbuild
// copies no JSON siblings, so the pipeline must stage them next to the bundle.
const SIBLING_DATA = [path.join('packages', 'web', 'src', 'server', 'lib', 'settings-registry.json')];

main().catch((error) => {
  process.stderr.write(`electron-package failed: ${error?.stack ?? error}\n`);
  process.exitCode = 1;
});

async function main() {
  const version = readRootVersion();
  log(`packaging NotNativeDesktop ${version} (win-x64, unsigned)`);
  ensureElectronBinary();
  buildWebUi();
  stageWebDist();
  await bundleServer();
  copySiblingData();
  runElectronBuilder(version);
  reportArtifacts();
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

function reportArtifacts() {
  const setup = findInstallers().at(0);
  if (!setup) throw new Error(`no installer under ${OUTPUT_DIR}`);
  const sha256 = createHash('sha256').update(readFileSync(setup)).digest('hex');
  log(`installer: ${path.basename(setup)} (${(statSync(setup).size / 1024 / 1024).toFixed(1)} MiB)`);
  log(`sha256:  ${sha256}`);
}

function findInstallers() {
  return readdirSync(OUTPUT_DIR)
    .filter((name) => /^NotNativeDesktop-Setup-.*-win-x64\.exe$/u.test(name))
    .map((name) => path.join(OUTPUT_DIR, name));
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
