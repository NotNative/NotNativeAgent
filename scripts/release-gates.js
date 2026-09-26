// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const errors = [];
const EXCLUDED_RELEASE_PREFIXES = Object.freeze(['node_modules/', 'dist/', '.git/', '.pnpm/', 'coverage/']);
const INCLUDED_RELEASE_PREFIXES = Object.freeze(['packages/ui/src/', 'packages/web/src/', 'packages/web/index.html', 'packages/web/vite.config.ts', 'packages/web/tsconfig.ui.json', 'packages/web/tsconfig.server.json', 'packages/ui/tsconfig.json', 'packages/ui/vitest.config.ts', 'scripts/', 'docs/architecture/', 'docs/build/', 'docs/planning/']);
const INCLUDED_ROOT_FILES = new Set(['package.json', 'README.md', 'VERSION', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'tsconfig.base.json']);
const MANIFEST = 'RELEASE_MANIFEST.sha256';
const LEDGER = 'RELEASE_VERSIONS.json';

await main().catch((error) => {
  process.stderr.write(`release gates failed: ${error?.message ?? 'unknown error'}\n`);
  process.exitCode = 1;
});

async function main() {
  const version = readVersion();
  verifyWorkspaceSafety();
  await coherentPackage(version);
  spawnGate('scripts/quality-gates.js', 'quality gates');
  spawnGate('scripts/smoke-test.js', 'smoke test');
  buildGate();
  const writeRequested = process.argv.includes('--write-hashes');
  if (errors.length === 0 && version) await sealVersionLedger(version, writeRequested);
  if (writeRequested && errors.length === 0 && version) await writeManifest();
  else if (!writeRequested && version) await verifyManifest();
  report();
}

function report() {
  if (errors.length > 0) {
    process.stderr.write(`${errors.join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('release-candidate gates passed\n');
  }
}

function readVersion() {
  let raw;
  try { raw = readFileSync(join(root, 'VERSION'), 'utf8').trim(); }
  catch { errors.push('VERSION is missing; run pnpm run version:bump'); return null; }
  if (!/^(\d{8})-([1-9]\d*)$/u.test(raw)) {
    errors.push('VERSION does not use YYYYMMDD-<iteration>');
    return null;
  }
  return raw;
}

function verifyWorkspaceSafety() {
  for (const manifest of ['package.json', 'packages/ui/package.json', 'packages/web/package.json']) {
    const pkg = safeJson(join(root, ...manifest.split('/')));
    if (pkg && pkg.private !== true) errors.push(`${manifest} must stay private:true`);
  }
}

function safeJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

async function coherentPackage(version) {
  if (!version) return;
  const [, date, iteration] = /^(\d{8})-([1-9]\d*)$/u.exec(version);
  const pkg = safeJson(join(root, 'package.json'));
  if (!pkg) {
    errors.push('root package.json is unreadable');
    return;
  }
  if (pkg.nnd_version !== version) errors.push('package nnd_version disagrees with VERSION');
  if (pkg.version !== `${date}.0.${iteration}`) errors.push('package semver mapping disagrees with VERSION');
}

function spawnGate(script, label) {
  const args = script === 'scripts/smoke-test.js'
    ? ['--experimental-transform-types', join(root, script)] : [join(root, script)];
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) errors.push(`${label} failed: ${failureText(result)}`);
  else if (result.stdout) process.stdout.write(result.stdout);
}

// The release gates must compile what ships. The 20260921-2 seal rotted here:
// quality gates + smoke never exercise the vite/CSS pipeline, so a broken
// relative @import in packages/web/src/index.css survived five slices.
function buildGate() {
  const webDir = join(root, 'packages', 'web');
  const viteCli = join(webDir, 'node_modules', 'vite', 'bin', 'vite.js');
  const result = spawnSync(process.execPath, [viteCli, 'build'], { cwd: webDir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) errors.push(`production build failed: ${failureText(result)}`);
  else {
    process.stdout.write('production build succeeded (packages/web/dist)\n');
    spawnGate('scripts/web-css-gate.mjs', 'web CSS gate');
  }
}

async function sealVersionLedger(version, recordMissing) {
  const ledger = await readJsonOrPushError(LEDGER) ?? { schema_version: 1, releases: [] };
  if (ledger.schema_version !== 1 || !Array.isArray(ledger.releases)) {
    errors.push('release version ledger is invalid');
    return;
  }
  const digest = await candidateDigest();
  const existing = ledger.releases.find((item) => item.version === version);
  if (existing && existing.content_sha256 !== digest) {
    errors.push(`version ${version} is sealed with different content; bump VERSION before re-releasing`);
    return;
  }
  if (existing) return;
  if (!recordMissing) {
    errors.push(`version ${version} is not sealed; run pnpm run release:check -- --write-hashes`);
    return;
  }
  ledger.releases.push({ version, content_sha256: digest });
  await writeFile(join(root, LEDGER), `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
}

async function candidateDigest() {
  const files = (await releaseFiles()).filter((item) => relativeName(item) !== MANIFEST && relativeName(item) !== LEDGER);
  const digest = createHash('sha256');
  for (const path of files) {
    digest.update(relativeName(path)).update(' ').update(await readFile(path)).update(' ');
  }
  return digest.digest('hex');
}

async function writeManifest() {
  const files = (await releaseFiles()).filter((item) => relativeName(item) !== MANIFEST);
  const lines = await Promise.all(files.sort((left, right) => relativeName(left).localeCompare(relativeName(right))).map(async (path) => {
    const hash = createHash('sha256').update(await readFile(path)).digest('hex');
    return `${hash} *${relativeName(path)}`;
  }));
  await writeFile(join(root, MANIFEST), `${lines.join('\n')}\n`, 'utf8');
}

async function verifyManifest() {
  let manifest;
  try { manifest = await readFile(join(root, MANIFEST), 'utf8'); }
  catch { errors.push(`${MANIFEST} is missing; run pnpm run release:check -- --write-hashes`); return; }
  const expected = new Map();
  for (const line of manifest.split(/\r?\n/u).filter(Boolean)) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/u.exec(line);
    if (match) expected.set(match[2], match[1]);
  }
  const lists = (await releaseFiles()).map((path) => relativeName(path)).sort();
  const differences = await hashDifferences(lists, expected);
  for (const [name, hash] of differences.mismatches) errors.push(`release artifact mismatch: ${name}`);
  for (const name of missingFromManifest(differences, lists, expected)) errors.push(`manifest missing file: ${name}`);
  for (const name of differences.stale) errors.push(`manifest references missing file: ${name}`);
  const visible = errors.slice(0, 40);
  errors.length = 0;
  errors.push(...visible);
}

async function hashDifferences(lists, expected) {
  const mismatches = [];
  const stale = new Set(expected.keys());
  for (const name of lists) {
    stale.delete(name);
    const expectedHash = expected.get(name);
    if (!expectedHash) continue;
    const actual = createHash('sha256').update(await readFile(join(root, name))).digest('hex');
    if (actual !== expectedHash) mismatches.push([name, actual]);
  }
  return { mismatches, stale: [...stale] };
}

function missingFromManifest(differences, lists, expected) {
  void differences;
  return lists.filter((name) => !expected.has(name));
}

async function releaseFiles() {
  const all = await walk(root);
  return all.filter((path) => releaseEligible(relativeName(path)));
}

async function readJsonOrPushError(name) {
  try { return JSON.parse(await readFile(join(root, name), 'utf8')); }
  catch (error) {
    errors.push(`${name} could not be read as JSON: ${error.code ?? error.message}`);
    return null;
  }
}

async function walk(directory) {
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) results.push(...await walk(path));
    else if (entry.isFile()) results.push(path);
  }
  return results;
}

function releaseEligible(name) {
  if (EXCLUDED_RELEASE_PREFIXES.some((prefix) => name.startsWith(prefix))) return false;
  return INCLUDED_ROOT_FILES.has(name) || INCLUDED_RELEASE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function relativeName(path) {
  return relative(root, path).replaceAll('\\', '/');
}

function failureText(result) {
  if (result.error) return `${result.error.code ?? 'spawn_failed'}: ${result.error.message}`;
  if (result.signal) return `terminated by ${result.signal}`;
  return String(result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`).trim();
}
