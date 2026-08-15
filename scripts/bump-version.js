// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function bumpVersion(root, options = {}, io = {}) {
  const read = io.readFile ?? readFile;
  const write = io.writeFile ?? writeFile;
  const versionPath = join(root, 'VERSION');
  const packagePath = join(root, 'package.json');
  const productPath = join(root, 'src', 'product.js');
  const sbomPath = join(root, 'SBOM.spdx.json');
  const originals = await Promise.all([
    read(versionPath, 'utf8'), read(packagePath, 'utf8'),
    read(productPath, 'utf8'), read(sbomPath, 'utf8'),
  ]);
  const current = originals[0].trim();
  const match = /^(\d{8})-([1-9]\d*)$/u.exec(current);
  if (!match) throw new Error('VERSION does not use YYYYMMDD-iteration');
  const date = options.date ?? localDate(new Date());
  const iteration = options.iteration ?? (date === match[1] ? Number(match[2]) + 1 : 1);
  if (!/^\d{8}$/u.test(date) || !validDate(date)) throw new Error('--date must be a real YYYYMMDD date');
  if (!Number.isSafeInteger(iteration) || iteration < 1) throw new Error('--iteration must be a positive integer');
  const version = `${date}-${iteration}`;
  const packageVersion = `${date}.0.${iteration}`;
  const packageJson = JSON.parse(originals[1]);
  const nextProduct = originals[2].replace(/export const VERSION = ['"][^'"]*['"];/u, `export const VERSION = '${version}';`);
  if (nextProduct === originals[2]) throw new Error('runtime VERSION declaration was not found');
  const sbom = JSON.parse(originals[3]);
  if (!Array.isArray(sbom.packages) || !sbom.packages[0]
    || typeof sbom.packages[0] !== 'object' || Array.isArray(sbom.packages[0])
    || typeof sbom.packages[0].name !== 'string' || typeof sbom.packages[0].SPDXID !== 'string'
    || typeof sbom.packages[0].versionInfo !== 'string') {
    throw new Error('SBOM must contain a primary package');
  }
  packageJson.version = packageVersion;
  packageJson.nna_version = version;
  sbom.name = `NotNativeAgent-${version}`;
  sbom.documentNamespace = `https://example.invalid/not-native-agent/sbom/${version}`;
  sbom.packages[0].versionInfo = version;
  await writeSynchronized([
    { path: versionPath, before: originals[0], after: `${version}\n` },
    { path: packagePath, before: originals[1], after: `${JSON.stringify(packageJson, null, 2)}\n` },
    { path: productPath, before: originals[2], after: nextProduct },
    { path: sbomPath, before: originals[3], after: `${JSON.stringify(sbom, null, 2)}\n` },
  ], write);
  return Object.freeze({ current, version });
}

export async function writeSynchronized(entries, write = writeFile) {
  const completed = [];
  try {
    for (const entry of entries) {
      await write(entry.path, entry.after, 'utf8');
      completed.push(entry);
    }
  } catch (error) {
    const rollbackFailures = [];
    for (const entry of completed.reverse()) {
      try { await write(entry.path, entry.before, 'utf8'); }
      catch (rollbackError) { rollbackFailures.push(rollbackError); }
    }
    if (rollbackFailures.length > 0) {
      const affected = completed.map((entry) => entry.path).join(', ');
      throw new AggregateError([error, ...rollbackFailures], `version update and rollback failed for: ${affected}`, { cause: error });
    }
    throw error;
  }
}

export function argumentsFrom(values) {
  const result = {}; const seen = new Set();
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index];
    if (option !== '--date' && option !== '--iteration') throw new Error(`unknown option ${option}`);
    if (seen.has(option)) throw new Error(`duplicate option ${option}`);
    seen.add(option);
    if (index + 1 >= values.length || values[index + 1].startsWith('--')) throw new Error(`missing value for ${option}`);
    const value = values[++index];
    if (option === '--date') result.date = value;
    else {
      if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error('--iteration must be a non-negative safe integer');
      }
      result.iteration = Number(value);
    }
  }
  return result;
}

function localDate(value) {
  const year = value.getFullYear().toString().padStart(4, '0');
  const month = (value.getMonth() + 1).toString().padStart(2, '0');
  const day = value.getDate().toString().padStart(2, '0');
  return `${year}${month}${day}`;
}

function validDate(value) {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const parsed = new Date(year, month - 1, day);
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day;
}

async function main() {
  const result = await bumpVersion(scriptRoot, argumentsFrom(process.argv.slice(2)));
  process.stdout.write(`Advanced NotNativeAgent from ${result.current} to ${result.version}.\n`);
  process.stdout.write('Platform conformance and release hashes intentionally remain stale until rerun.\n');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`version bump failed: ${error?.message ?? 'unknown error'}\n`);
    process.exitCode = 1;
  });
}
