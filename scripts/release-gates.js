// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const RELEASE_EXCLUDED_PREFIXES = Object.freeze([
  'docs/planning/', 'desktop/', 'docs/benchmarks/', 'docs/conformance/',
  'docs/architecture/',
  'node_modules/', '.git/', '.nna/', '.tmp/', '.tmp-npm-cache/', '.npm-cache/',
]);
// docs/ ships product documentation only; planning/development artifacts,
// architecture records, generated graphs, benchmark reports, and release
// evidence are local/operator-owned and stay out of the manifest
// (the conformance JSON is still read for its required-evidence checks).
const RELEASE_INCLUDED_PREFIXES = Object.freeze(['src/', 'resources/', 'docs/', 'scripts/', 'test/']);
const RELEASE_INCLUDED_ROOT_FILES = new Set([
  'package.json', 'README.md', 'VERSION', 'LICENSE', 'NOTICE', 'SECURITY.md', 'SUPPORT.md',
  'THIRD_PARTY_NOTICES.md', 'SBOM.spdx.json', 'RELEASE_MANIFEST.sha256', 'RELEASE_VERSIONS.json',
  'install.ps1', 'install.sh', 'uninstall.ps1', 'uninstall.sh',
]);
const releaseVersion = (await readFile(join(root, 'VERSION'), 'utf8')).trim();
const packageJson = await json('package.json');
const sbom = await json('SBOM.spdx.json');
const thirdPartyNotices = await readFile(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8').catch(() => '');
const conformancePath = await latestConformancePath();
const conformance = conformancePath ? await json(conformancePath) : null;
const versionLedger = await json('RELEASE_VERSIONS.json');
const productSource = await readFile(join(root, 'src/product.js'), 'utf8');
if (packageJson && packageJson.license !== 'Apache-2.0') errors.push('package license is not Apache-2.0');
if (packageJson && Object.keys(packageJson.dependencies ?? {}).length > 0) errors.push('runtime dependencies are not empty');
if (sbom && sbom.spdxVersion !== 'SPDX-2.3') errors.push('SBOM format is invalid');
verifyDependencies();
const versionMatch = /^(\d{8})-([1-9]\d*)$/u.exec(releaseVersion);
if (!versionMatch) errors.push('VERSION does not use YYYYMMDD-iteration');
const mappedPackageVersion = versionMatch ? `${versionMatch[1]}.0.${versionMatch[2]}` : null;
if (packageJson && (packageJson.nna_version !== releaseVersion || packageJson.version !== mappedPackageVersion)) errors.push('package versions disagree with VERSION');
if (sbom && sbom.packages?.[0]?.versionInfo !== releaseVersion) errors.push('SBOM version disagrees with VERSION');
if (!productSource.includes(`VERSION = '${releaseVersion}'`)) errors.push('runtime version disagrees with VERSION');
if (conformance && conformance.release !== releaseVersion) errors.push('platform conformance version disagrees with VERSION');
for (const result of conformance?.results ?? []) {
  if (result.release !== releaseVersion) {
    errors.push(`platform evidence version disagrees: ${result.environment ?? 'unnamed environment'}`);
  }
}
if (conformance?.results?.some((item) => item.installer_lifecycle !== 'passed')) errors.push('platform installer conformance is incomplete');
if (conformance?.results?.some((item) => !item.missing_node_bootstrap?.startsWith('passed'))) errors.push('dependency bootstrap conformance is incomplete');
if (conformance?.results?.some((item) => !item.reinstall_replacement?.includes('data preserved'))) errors.push('reinstall preservation conformance is incomplete');
if (conformance?.results?.some((item) => !item.bare_launch_onboarding?.startsWith('passed'))) errors.push('bare launch conformance is incomplete');
for (const platform of ['windows', 'linux', 'macos']) {
  if (conformance && !conformance.results?.some((item) => item.environment?.toLowerCase().includes(platform))) {
    errors.push(`native ${platform} conformance evidence is missing`);
  }
}
for (const required of [
  'VERSION', 'RELEASE_VERSIONS.json', 'LICENSE', 'NOTICE', 'SECURITY.md', 'SUPPORT.md', 'THIRD_PARTY_NOTICES.md',
  'SBOM.spdx.json', 'docs/RELEASE_READINESS.md', 'docs/INSTALLATION.md', 'docs/VERSIONING.md',
  'scripts/bump-version.js',
  conformancePath,
  'install.ps1', 'uninstall.ps1', 'install.sh', 'uninstall.sh',
]) {
  if (!required) { errors.push('platform conformance evidence is missing'); continue; }
  try { await readFile(join(root, required)); } catch { errors.push(`${required} is missing`); }
}
run(process.execPath, ['scripts/quality-gates.js']);
// Scoped + serial: the bundled desktop/ subtree has its own vitest suites, and the
// census tests scan the live process table — parallel runners make them flake.
run(process.execPath, ['--test', '--test-concurrency=1', 'test/*.test.js']);
const writeRequested = process.argv.includes('--write-hashes');
// Invariant: --write-hashes records the CURRENT content set even when unrelated gates are
// red (e.g. operator-owned platform conformance awaiting its rerun); writing
// hashes certifies nothing — this gate still exits 1 below on those errors,
// and the verify path (no flag) still enforces the recorded hashes.
await finishReleaseHashes(writeRequested, errors.length);
if (errors.length > 0) {
  process.stderr.write(`${errors.join('\n')}\n`); process.exitCode = 1;
} else process.stdout.write('automated release-candidate gates passed\n');

async function finishReleaseHashes(writeRequested, priorGateErrorCount) {
  // Security: A conflicting or invalid seal is an integrity failure, not an unrelated gate error.
  const mayWriteHashes = await verifyVersionLedger(
    writeRequested && priorGateErrorCount === 0, !writeRequested || priorGateErrorCount === 0,
  );
  if (writeRequested) {
    if (mayWriteHashes) await writeHashes();
  } else await verifyReleaseHashes();
}

function verifyDependencies() {
  if (!sbom || !packageJson) return;
  const packages = Array.isArray(sbom.packages) ? sbom.packages : [];
  for (const item of packages.filter((candidate) => candidate.name !== packageJson.name)) {
    if (item.versionInfo !== undefined
      && (typeof item.versionInfo !== 'string' || item.versionInfo.length === 0)) {
      errors.push(`SBOM dependency version is invalid: ${item.name}`);
    }
    if (item.versionInfo === undefined && (typeof item.comment !== 'string' || item.comment.length === 0)) {
      errors.push(`SBOM dependency without a known version needs an explanatory comment: ${item.name}`);
    }
    if (typeof item.licenseDeclared !== 'string' || typeof item.licenseConcluded !== 'string') errors.push(`SBOM dependency license is missing: ${item.name}`);
    if (!thirdPartyNotices.includes(item.name)) errors.push(`third-party notice is missing for SBOM dependency: ${item.name}`);
  }
  const searxng = packages.find((candidate) => candidate.name === 'SearXNG');
  if (!searxng?.checksums?.some((checksum) => (
    checksum.algorithm === 'SHA256' && /^[0-9a-f]{64}$/u.test(checksum.checksumValue)
  ))) {
    errors.push('SearXNG checksum is missing from SBOM');
  }
}

async function writeHashes() {
  const files = (await collect(root)).filter((path) => (
    !path.endsWith('RELEASE_MANIFEST.sha256') && releaseEligible(path)
  ));
  const lines = await Promise.all(files.sort().map(async (path) => {
    const hash = createHash('sha256').update(await readFile(path)).digest('hex');
    return `${hash} *${relative(root, path).replaceAll('\\', '/')}`;
  }));
  await writeFile(join(root, 'RELEASE_MANIFEST.sha256'), `${lines.join('\n')}\n`, 'utf8');
}

async function verifyReleaseHashes() {
  let manifest;
  try { manifest = await readFile(join(root, 'RELEASE_MANIFEST.sha256'), 'utf8'); }
  catch { errors.push('RELEASE_MANIFEST.sha256 is missing; run release:check -- --write-hashes'); return; }
  const expected = new Map();
  for (const line of manifest.split(/\r?\n/u).filter(Boolean)) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/u.exec(line);
    if (!match) { errors.push('release manifest line is malformed'); continue; }
    expected.set(match[2], match[1]);
  }
  const actualPaths = (await collect(root))
    .filter((path) => !path.endsWith('RELEASE_MANIFEST.sha256') && releaseEligible(path))
    .map((path) => relative(root, path).replaceAll('\\', '/')).sort();
  const differences = [];
  const actualHashes = await Promise.all(actualPaths.map(async (name) => [
    name, createHash('sha256').update(await readFile(join(root, name))).digest('hex'),
  ]));
  for (const [name, actualHash] of actualHashes) {
    const expectedHash = expected.get(name);
    if (!expectedHash) { differences.push(`release manifest missing file: ${name}`); continue; }
    if (actualHash !== expectedHash) differences.push(`release artifact mismatch: ${name}`);
    expected.delete(name);
  }
  for (const name of expected.keys()) differences.push(`release manifest references missing file: ${name}`);
  if (differences.length > 0) {
    const visible = differences.slice(0, 20);
    errors.push(...visible);
    if (differences.length > visible.length) {
      errors.push(`release manifest has ${differences.length - visible.length} additional difference(s)`);
    }
  }
}

async function verifyVersionLedger(recordMissing, reportMissing = true) {
  if (!versionLedger || versionLedger.schema_version !== 1 || !Array.isArray(versionLedger.releases)) {
    errors.push('release version ledger is invalid'); return false;
  }
  const seenVersions = new Set();
  for (const item of versionLedger.releases) {
    if (!item || typeof item.version !== 'string' || !/^\d{8}-[1-9]\d*$/u.test(item.version)
      || typeof item.content_sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(item.content_sha256)
      || seenVersions.has(item.version)) {
      errors.push('release version ledger has an invalid or duplicate seal'); return false;
    }
    seenVersions.add(item.version);
  }
  const digest = await candidateDigest();
  const existing = versionLedger.releases.find((item) => item.version === releaseVersion);
  if (existing && existing.content_sha256 !== digest) {
    errors.push(`version ${releaseVersion} is already sealed with different content; bump VERSION`);
    return false;
  }
  if (existing) return true;
  if (!recordMissing) {
    if (reportMissing) errors.push(`version ${releaseVersion} is not sealed; run release:check -- --write-hashes`);
    return true;
  }
  versionLedger.releases.push({ version: releaseVersion, content_sha256: digest });
  await writeFile(join(root, 'RELEASE_VERSIONS.json'), `${JSON.stringify(versionLedger, null, 2)}\n`, 'utf8');
  return true;
}

async function candidateDigest() {
  const excluded = new Set(['RELEASE_MANIFEST.sha256', 'RELEASE_VERSIONS.json']);
  const files = (await collect(root)).map((path) => ({
    path, name: relative(root, path).replaceAll('\\', '/'),
  })).filter((item) => !excluded.has(item.name) && releaseEligible(item.path))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const digest = createHash('sha256');
  const contents = await Promise.all(files.map((file) => readFile(file.path)));
  for (let index = 0; index < files.length; index += 1) {
    digest.update(files[index].name); digest.update('\0'); digest.update(contents[index]); digest.update('\0');
  }
  return digest.digest('hex');
}

async function collect(directory) {
  const result = [];
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    throw new Error(`release file scan failed at ${relative(root, directory) || '.'}: ${error.code ?? error.message}`, { cause: error });
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await collect(path));
    else result.push(path);
  }
  return result;
}

function releaseEligible(path) {
  const name = relative(root, path).replaceAll('\\', '/');
  if (RELEASE_EXCLUDED_PREFIXES.some((prefix) => name.startsWith(prefix))) return false;
  return RELEASE_INCLUDED_ROOT_FILES.has(name)
    || RELEASE_INCLUDED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) errors.push(result.stderr || `${args.join(' ')} failed`);
}

async function json(path) {
  try { return JSON.parse(await readFile(join(root, path), 'utf8')); }
  catch (error) { errors.push(`${path} could not be read as JSON: ${error.code ?? error.message}`); return null; }
}

async function latestConformancePath() {
  const directory = 'docs/conformance';
  try {
    const candidates = (await readdir(join(root, directory)))
      .filter((name) => /^windows-linux-\d{4}-\d{2}-\d{2}\.json$/u.test(name)).sort();
    return candidates.length > 0 ? `${directory}/${candidates.at(-1)}` : null;
  } catch (error) {
    errors.push(`${directory} could not be scanned: ${error.code ?? error.message}`);
    return null;
  }
}
