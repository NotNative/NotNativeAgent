// SPDX-License-Identifier: Apache-2.0
/** Content-based freshness check for the source-installed Electron artifacts. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAMP = path.join(ROOT, 'packages', 'electron', 'build-stamp.json');
const SKIP_SOURCE_DIR_NAMES = new Set(['node_modules', '.git']);
const SKIP_SOURCE_PATHS = new Set([
  'packages/web/dist',
  'packages/electron/dist-server',
  'packages/electron/resources',
  'packages/web/coverage',
]);
const INPUTS = [
  'packages/ui', 'packages/web', 'packages/electron', 'scripts',
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'VERSION',
];
const ARTIFACTS = [
  'packages/web/dist',
  'packages/electron/dist-server/server.mjs',
  'packages/electron/dist-server/settings-registry.json',
  'packages/electron/dist-server/node_modules/node-pty',
  'packages/electron/assets/tray-running.png',
  'packages/electron/assets/tray-stopped.png',
];

function filesUnder(target, result = [], { excludeGenerated = true } = {}) {
  if (!existsSync(target)) return result;
  if (lstatSync(target).isSymbolicLink()) {
    throw new Error(`cannot stamp a symbolic-link path: ${path.relative(ROOT, target)}`);
  }
  const metadata = statSync(target);
  if (metadata.isFile()) { result.push(target); return result; }
  for (const entry of readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(target, entry.name);
    const relative = path.relative(ROOT, full).replaceAll('\\', '/');
    // Keep source exclusions scoped to known generated/vendor paths. A broad
    // `dist` or `resources` name can also occur in checked-in source trees.
    // Artifact walks include every directory, especially Vite's dist/assets.
    if (excludeGenerated && (SKIP_SOURCE_DIR_NAMES.has(entry.name) || SKIP_SOURCE_PATHS.has(relative))) continue;
    if (relative === 'packages/electron/build-stamp.json') continue;
    if (entry.isSymbolicLink()) {
      throw new Error(`cannot stamp a symbolic-link path: ${path.relative(ROOT, full)}`);
    }
    if (entry.isDirectory()) filesUnder(full, result, { excludeGenerated });
    else if (entry.isFile()) result.push(full);
  }
  return result;
}

function treeDigest(paths, options) {
  const files = paths.flatMap((relative) => filesUnder(path.join(ROOT, relative), [], options));
    // Sorting by repository-relative spelling makes this stable across OSes.
  files.sort((a, b) => {
    const left = path.relative(ROOT, a).replaceAll('\\', '/');
    const right = path.relative(ROOT, b).replaceAll('\\', '/');
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(path.relative(ROOT, file).replaceAll('\\', '/')).update('\0');
    hash.update(readFileSync(file)).update('\0');
  }
  return { files: files.length, sha256: hash.digest('hex') };
}

function currentStamp() {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (typeof pkg.nnd_version !== 'string' || !/^\d{8}-[1-9]\d*$/u.test(pkg.nnd_version)) {
    throw new Error('root package does not contain a valid nnd_version');
  }
  const missing = ARTIFACTS.filter((relative) => !existsSync(path.join(ROOT, relative)));
  if (missing.length) throw new Error(`required build artifacts are missing: ${missing.join(', ')}`);
  return {
    schema: 1,
    nndVersion: pkg.nnd_version,
    source: treeDigest(INPUTS, { excludeGenerated: true }),
    artifacts: treeDigest(ARTIFACTS, { excludeGenerated: false }),
  };
}

function main() {
  const action = process.argv[2];
  if (process.argv.length !== 3 || !['write', 'check'].includes(action)) {
    throw new Error('usage: node scripts/electron-build-stamp.mjs write|check');
  }
  const actual = currentStamp();
  if (action === 'write') {
    writeFileSync(STAMP, `${JSON.stringify(actual, null, 2)}\n`, 'utf8');
    process.stdout.write(`build stamp written (${actual.nndVersion}; ${actual.source.files} source files; ${actual.artifacts.files} artifact files)\n`);
    return;
  }
  let expected;
  try { expected = JSON.parse(readFileSync(STAMP, 'utf8')); }
  catch { throw new Error('build stamp is missing or invalid'); }
  if (expected?.schema !== actual.schema || expected?.nndVersion !== actual.nndVersion
    || expected?.source?.sha256 !== actual.source.sha256
    || expected?.artifacts?.sha256 !== actual.artifacts.sha256) {
    throw new Error('build stamp is stale or one or more build artifacts changed');
  }
  process.stdout.write(`build stamp is current (${actual.nndVersion})\n`);
}

try { main(); }
catch (error) {
  process.stderr.write(`electron build stamp: ${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
}
