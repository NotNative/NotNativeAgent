// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(join(fileURLToPath(import.meta.url), '..', '..'));

export async function bumpVersion(rootDir, options = {}, io = {}) {
  const read = io.readFile ?? readFile;
  const write = io.writeFile ?? writeFile;
  const versionPath = join(rootDir, 'VERSION');
  const packagePath = join(rootDir, 'package.json');
  const originals = await Promise.all([read(versionPath, 'utf8').catch(() => null), read(packagePath, 'utf8')]);
  const date = options.date ?? localDate(new Date());
  if (!validDate(date)) throw new Error('--date must be a real YYYYMMDD date');
  const iteration = options.iteration ?? nextIteration(originals[0], date);
  if (!Number.isSafeInteger(iteration) || iteration < 1) throw new Error('--iteration must be a positive integer');
  const version = `${date}-${iteration}`;
  const packageVersion = `${date}.0.${iteration}`;
  const packageJson = parseJson(originals[1], 'package.json');
  packageJson.version = packageVersion;
  packageJson.nnd_version = version;
  await writeSynchronized([
    { path: versionPath, before: originals[0], after: `${version}\n` },
    { path: packagePath, before: originals[1], after: `${JSON.stringify(packageJson, null, 2)}\n` },
  ], write);
  if (originals[0] === null && io.writeFile === undefined) {
    // VERSION was bootstrapped on this run; keep history honest in the console only.
  }
  return { from: originals[0]?.trim() ?? 'bootstrapped', to: version };
}

function nextIteration(versionFile, date) {
  const current = versionFile?.trim();
  if (!current) return 1;
  const match = /^(\d{8})-([1-9]\d*)$/u.exec(current);
  if (!match) throw new Error('VERSION must use the YYYYMMDD-<iteration> scheme');
  return date === match[1] ? Number(match[2]) + 1 : 1;
}

export async function writeSynchronized(entries, write = writeFile) {
  const done = [];
  try {
    for (const entry of entries) {
      await write(entry.path, entry.after, 'utf8');
      done.push(entry);
    }
  } catch (error) {
    const rollbackFailures = [];
    for (const entry of [...done].reverse()) {
      try { await write(entry.path, entry.before ?? '', 'utf8'); }
      catch (rollbackError) { rollbackFailures.push(rollbackError); }
    }
    if (rollbackFailures.length > 0) {
      throw new AggregateError([error, ...rollbackFailures], 'version update and rollback both failed', { cause: error });
    }
    throw error;
  }
}

/** --check validates the committed VERSION/package pairing without writing. */
export async function checkVersionPairing(rootDir) {
  const versionPath = join(rootDir, 'VERSION');
  const packagePath = join(rootDir, 'package.json');
  const [versionFile, packageSource] = await Promise.all([readFile(versionPath, 'utf8'), readFile(packagePath, 'utf8')]);
  const current = versionFile.trim();
  if (!/^(\d{8})-([1-9]\d*)$/u.test(current)) throw new Error('VERSION is malformed or bootstrapped; run npm run version:bump');
  const packageJson = parseJson(packageSource, 'package.json');
  const [, date, iteration] = /^(\d{8})-([1-9]\d*)$/u.exec(current);
  const expectedPackageVersion = `${date}.0.${iteration}`;
  if (packageJson.version !== expectedPackageVersion) {
    throw new Error(`package version ${packageJson.version} disagrees with VERSION ${current}`);
  }
  if (packageJson.nnd_version !== current) {
    throw new Error(`package nnd_version ${packageJson.nnd_version} disagrees with VERSION ${current}`);
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

export function argumentsFrom(values) {
  const result = {};
  const seen = new Set();
  const handlers = {
    '--date': (value) => value,
    '--iteration': (value) => {
      if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('--iteration must be a safe integer');
      return Number(value);
    },
  };
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index];
    if (!handlers[option] || seen.has(option)) throw new Error(`unknown or duplicate option ${option}`);
    seen.add(option);
    if (index + 1 >= values.length || values[index + 1].startsWith('--')) throw new Error(`missing value for ${option}`);
    result[option.slice(2)] = handlers[option](values[++index]);
  }
  return result;
}

function localDate(value) {
  return `${value.getFullYear()}`.padStart(4, '0')
    + `${value.getMonth() + 1}`.padStart(2, '0')
    + `${value.getDate()}`.padStart(2, '0');
}

function validDate(value) {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  if (value.length !== 8) return false;
  const parsed = new Date(year, month - 1, day);
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--check')) {
    if (args.some((value) => value !== '--check')) throw new Error(`unknown option with --check: ${args.join(' ')}`);
    const current = await checkVersionPairing(root);
    process.stdout.write(`version pairing is coherent: ${current}\n`);
    return;
  }
  const result = await bumpVersion(root, argumentsFrom(args));
  process.stdout.write(`advanced NotNativeDesktop ${result.from} -> ${result.to}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`version bump failed: ${error?.message ?? 'unknown error'}\n`);
    process.exitCode = 1;
  });
}
