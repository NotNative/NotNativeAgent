// SPDX-License-Identifier: Apache-2.0
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(realpathSync(fileURLToPath(import.meta.url))));
const checkOnlyMessage = 'desktop version is a root-stamped mirror; run `node scripts/bump-version.js` from the NNA repository root to advance both stamps';

/** --check validates the mirror pairing without writing; the desktop stamp is written only by the root bump. */
export async function checkVersionPairing(rootDir) {
  const versionPath = join(rootDir, 'VERSION');
  const packagePath = join(rootDir, 'package.json');
  const rootVersionPath = join(rootDir, '..', 'VERSION');
  const [versionFile, packageSource, rootVersionFile] = await Promise.all([
    readFile(versionPath, 'utf8'),
    readFile(packagePath, 'utf8'),
    readFile(rootVersionPath, 'utf8'),
  ]);
  const current = versionFile.trim();
  if (!/^(\d{8})-([1-9]\d*)$/u.test(current)) throw new Error(`desktop VERSION is malformed; ${checkOnlyMessage}`);
  const rootCurrent = rootVersionFile.trim();
  if (rootCurrent !== current) {
    throw new Error(`desktop VERSION ${current} disagrees with root VERSION ${rootCurrent}; ${checkOnlyMessage}`);
  }
  const packageJson = parseJson(packageSource, 'package.json');
  if (typeof packageJson.version !== 'string' || typeof packageJson.desktop_version !== 'string') {
    throw new Error(`package.json must contain string version and desktop_version fields; ${checkOnlyMessage}`);
  }
  const [, date, iteration] = /^(\d{8})-([1-9]\d*)$/u.exec(current);
  const expectedPackageVersion = `${date}.0.${iteration}`;
  if (packageJson.version !== expectedPackageVersion) {
    throw new Error(`package version ${packageJson.version} disagrees with VERSION ${current}`);
  }
  if (packageJson.desktop_version !== current) {
    throw new Error(`package desktop_version ${packageJson.desktop_version} disagrees with VERSION ${current}`);
  }
  return current;
}

function parseJson(source, label) {
  let value;
  try { value = JSON.parse(source); }
  catch (error) { throw new Error(`${label} is not valid JSON`, { cause: error }); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must contain a JSON object`);
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  // Compatibility: `--check` remains an accepted no-op flag (the script is check-only now).
  const unknown = args.filter((value) => value !== '--check');
  if (unknown.length > 0) throw new Error(`unknown option: ${unknown.join(' ')}; only --check is supported`);
  const current = await checkVersionPairing(root);
  process.stdout.write(`version pairing is coherent: ${current}\n`);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`version check failed: ${error?.message ?? 'unknown error'}\n`);
    process.exitCode = 1;
  });
}
