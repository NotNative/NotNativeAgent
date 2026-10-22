// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { releaseFiles as collectReleaseFiles } from './release-content.mjs';
import { sealVersionLedger } from './release-version-ledger.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const errors = [];
const MANIFEST = 'RELEASE_MANIFEST.sha256';

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
  featureParityGate();
  settingsCoverageGate();
  buildGate();
  const writeRequested = process.argv.includes('--write-hashes');
  if (errors.length === 0 && version) {
    await sealVersionLedger({ root, version, recordMissing: writeRequested, candidateDigest, errors });
  }
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

// C1's census gate is a paired-repository check: it pins the settings census to
// the classified NNA catalog and rejects unclassified native keys and CLI
// options. It runs when the sealing environment names the paired NNA checkout
// through NNA_SOURCE_ROOT; a missing checkout is a loudly reported skip, never
// a silent pass (guide 05 records the skip as an unverified gate).
function settingsCoverageGate() {
  const nnaSource = process.env.NNA_SOURCE_ROOT;
  if (!nnaSource) {
    process.stdout.write('settings-coverage gate skipped: NNA_SOURCE_ROOT is not set; this seal leaves settings coverage unverified\n');
    return;
  }
  const result = spawnSync(process.execPath,
    [join(root, 'scripts', 'settings-coverage-gate.mjs'), resolve(root, nnaSource)],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  // Always surface the gate's stdout: its JSON report is the actionable
  // evidence when the gate fails, and failureText alone would lose it.
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.status !== 0) errors.push(`settings coverage gate failed: ${failureText(result)}`);
}

// V4's W acceptance ledger is a self-contained drift gate: the records file
// must stay pinned to the parity table and honor the evidence rules. A
// failing ledger blocks the seal, because an unpinned ledger could claim
// completion without installed evidence.
function featureParityGate() {
  const auditUrl = pathToFileURL(join(root, 'scripts', 'feature-parity-records.mjs')).href;
  const result = spawnSync(process.execPath,
    ['--input-type=module', '-e',
      `import { auditRecords } from ${JSON.stringify(auditUrl)};
       const { problems, expected, recorded } = await auditRecords();
       if (problems.length) { console.error(problems.join('\\n')); process.exit(1); }
       console.log('feature parity records complete: ' + recorded + '/' + expected);`],
    { cwd: root, encoding: 'utf8' });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.status !== 0) errors.push(`feature parity ledger gate failed: ${failureText(result)}`);
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

async function candidateDigest() {
  const files = (await releaseFiles()).filter((item) => relativeName(item) !== MANIFEST && relativeName(item) !== 'RELEASE_VERSIONS.json');
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
  return collectReleaseFiles(root);
}

function relativeName(path) {
  return relative(root, path).replaceAll('\\', '/');
}

function failureText(result) {
  if (result.error) return `${result.error.code ?? 'spawn_failed'}: ${result.error.message}`;
  if (result.signal) return `terminated by ${result.signal}`;
  return String(result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`).trim();
}
