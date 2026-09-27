// SPDX-License-Identifier: Apache-2.0
/** Installed NND package registration. Registration does not start the GUI. */
import { readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { ContractError } from './ids.js';

const REGISTRY_FILE = 'nnd-package.json';
const MANIFEST_FILE = join('nna-integration', 'nnd-local', 'integration.json');
const LIMIT = 16 * 1024;
const VERSION = /^\d{8}-[1-9]\d{0,5}$/u;

function invalid(code, message) { throw new ContractError(code, message); }
function contained(root, target) {
  const part = relative(root, target);
  return part !== '..' && !part.startsWith(`..\\`) && !part.startsWith('../') && !isAbsolute(part);
}
async function samePackageRoot(left, right) {
  const canonicalLeft = await realpath(left).catch(() => resolve(left));
  const canonicalRight = await realpath(right).catch(() => resolve(right));
  return process.platform === 'win32'
    ? canonicalLeft.toLowerCase() === canonicalRight.toLowerCase()
    : canonicalLeft === canonicalRight;
}
async function regularWithin(root, path) {
  const actual = await realpath(join(root, path)).catch(() => null);
  return actual && contained(root, actual) && (await stat(actual).catch(() => null))?.isFile() ? actual : null;
}
async function boundedJson(path, code) {
  const metadata = await stat(path).catch(() => null);
  if (!metadata?.isFile() || metadata.size > LIMIT) invalid(code, 'NND package metadata is missing or invalid');
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { invalid(code, 'NND package metadata is invalid JSON'); }
}

export async function validateNndPackage(rootInput) {
  if (typeof rootInput !== 'string' || !rootInput.trim() || !isAbsolute(rootInput.trim())) {
    invalid('nnd_package_root_invalid', 'NND package root must be absolute');
  }
  const root = await realpath(rootInput.trim()).catch(() => null);
  if (!root || !(await stat(root))?.isDirectory()) invalid('nnd_package_root_invalid', 'NND package root is unavailable');
  const manifestPath = await regularWithin(root, MANIFEST_FILE);
  const packagePath = await regularWithin(root, 'package.json');
  const serverPath = await regularWithin(root, join('packages', 'electron', 'dist-server', 'server.mjs'));
  const webPath = await regularWithin(root, join('packages', 'web', 'dist', 'index.html'));
  if (!manifestPath || !packagePath || !serverPath || !webPath) {
    invalid('nnd_package_incomplete', 'NND package manifest or built assets are missing');
  }
  const manifest = await boundedJson(manifestPath, 'nnd_package_manifest_invalid');
  const packageInfo = await boundedJson(packagePath, 'nnd_package_manifest_invalid');
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || manifest.id !== 'nnd-local' || manifest.ownership !== 'nnd' || manifest.scope !== 'local-gui'
    || manifest.nna_integration_protocol !== '1.0' || !VERSION.test(manifest.version)
    || packageInfo?.nnd_version !== manifest.version) {
    invalid('nnd_package_manifest_invalid', 'NND package identity, protocol, or version is incompatible');
  }
  return Object.freeze({ root, manifestPath, version: manifest.version, protocol: '1.0' });
}

export async function runNndPackageCommand(args, paths) {
  const [action, rootInput] = args;
  if (!['activate', 'deactivate', 'status'].includes(action) || args.length !== (action === 'status' ? 1 : 2)) {
    invalid('nnd_package_command_invalid', 'NND package supports activate ROOT, deactivate ROOT, or status');
  }
  const registry = join(paths.config, REGISTRY_FILE);
  if (action === 'activate') {
    const packageInfo = await validateNndPackage(rootInput);
    const tmp = `${registry}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify({ root: packageInfo.root, version: packageInfo.version, protocol: packageInfo.protocol }), { flag: 'wx', mode: 0o600 });
      await rename(tmp, registry);
    } finally { await unlink(tmp).catch(() => {}); }
    return { registered: true, valid: true, root: packageInfo.root, version: packageInfo.version };
  }
  const stored = await readFile(registry, 'utf8').then(JSON.parse).catch(() => null);
  if (!stored) return { registered: false };
  if (typeof stored.root !== 'string' || !isAbsolute(stored.root) || !VERSION.test(stored.version)) {
    invalid('nnd_package_registry_invalid', 'NND package registry is invalid');
  }
  if (action === 'deactivate') {
    if (!(await samePackageRoot(rootInput, stored.root))) invalid('nnd_package_root_mismatch', 'Registered NND package root differs');
    await unlink(registry);
    return { registered: false };
  }
  try {
    const current = await validateNndPackage(stored.root);
    return { registered: true, valid: current.version === stored.version, root: current.root, version: current.version };
  } catch (error) {
    return { registered: true, valid: false, root: stored.root, version: stored.version, reason: error.code ?? 'nnd_package_invalid' };
  }
}

export async function assertRegisteredNndPackage(rootInput, paths) {
  const status = await runNndPackageCommand(['status'], paths);
  if (!status.registered || !status.valid || !(await samePackageRoot(rootInput, status.root))) {
    invalid('nnd_package_not_active', 'Installed NND package is not the active validated GUI package');
  }
  return status;
}
