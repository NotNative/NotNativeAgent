// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const current = (await readFile(join(root, 'VERSION'), 'utf8')).trim();
const match = /^(\d{8})-([1-9]\d*)$/u.exec(current);
if (!match) throw new Error('VERSION does not use YYYYMMDD-iteration');
const options = argumentsFrom(process.argv.slice(2));
const date = options.date ?? localDate(new Date());
const iteration = options.iteration ?? (date === match[1] ? Number(match[2]) + 1 : 1);
if (!/^\d{8}$/u.test(date) || !validDate(date)) throw new Error('--date must be a real YYYYMMDD date');
if (!Number.isSafeInteger(iteration) || iteration < 1) throw new Error('--iteration must be a positive integer');
const version = `${date}-${iteration}`;
const packageVersion = `${date}.0.${iteration}`;

const packagePath = join(root, 'package.json');
const productPath = join(root, 'src', 'product.js');
const sbomPath = join(root, 'SBOM.spdx.json');
const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
const productSource = await readFile(productPath, 'utf8');
const sbom = JSON.parse(await readFile(sbomPath, 'utf8'));
const nextProduct = productSource.replace(/export const VERSION = '[^']+';/u, `export const VERSION = '${version}';`);
if (nextProduct === productSource) throw new Error('runtime VERSION declaration was not found');
packageJson.version = packageVersion;
packageJson.nna_version = version;
sbom.name = `NotNativeAgent-${version}`;
sbom.documentNamespace = `https://example.invalid/not-native-agent/sbom/${version}`;
sbom.packages[0].versionInfo = version;

await writeFile(join(root, 'VERSION'), `${version}\n`, 'utf8');
await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
await writeFile(productPath, nextProduct, 'utf8');
await writeFile(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`, 'utf8');
process.stdout.write(`Advanced NotNativeAgent from ${current} to ${version}.\n`);
process.stdout.write('Platform conformance and release hashes intentionally remain stale until rerun.\n');

function argumentsFrom(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === '--date') result.date = values[++index];
    else if (values[index] === '--iteration') result.iteration = Number(values[++index]);
    else throw new Error(`unknown option ${values[index]}`);
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
