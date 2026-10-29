// SPDX-License-Identifier: Apache-2.0
/** Installed desktop package registration. Registration does not start the GUI. */
import { open, realpath, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { ContractError } from './ids.js';
import { validateDesktopServiceArtifacts } from './desktop-service-package.js';
import { readDesktopPackageRegistration, mutateDesktopPackageRegistration } from './desktop-package-registration.js';
import { transactLockedManifest } from './persistence/manifest-transaction.js';

const REGISTRY_FILE = 'desktop-package.json';
const MANIFEST_FILE = join('nna-integration', 'desktop-local', 'integration.json');
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
  let file;
  try {
    file = await open(path, 'r');
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > LIMIT) invalid(code, 'desktop package metadata is missing or invalid');
    const buffer = Buffer.alloc(LIMIT + 1); let count = 0;
    while (count < buffer.length) {
      const read = await file.read(buffer, count, buffer.length - count, null);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    if (count > LIMIT) invalid(code, 'desktop package metadata exceeds its size bound');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count)));
  } catch (error) {
    if (error instanceof ContractError) throw error;
    invalid(code, 'desktop package metadata is invalid or unavailable');
  } finally { await file?.close(); }
}

export async function validateDesktopPackage(rootInput, options = {}) {
  if (typeof rootInput !== 'string' || !rootInput.trim() || !isAbsolute(rootInput.trim())) {
    invalid('desktop_package_root_invalid', 'desktop package root must be absolute');
  }
  const root = await realpath(rootInput.trim()).catch(() => null);
  if (!root || !(await stat(root))?.isDirectory()) invalid('desktop_package_root_invalid', 'desktop package root is unavailable');
  const manifestPath = await regularWithin(root, MANIFEST_FILE);
  const packagePath = await regularWithin(root, 'package.json');
  const serverPath = await regularWithin(root, join('packages', 'electron', 'dist-server', 'server.mjs'));
  const webPath = await regularWithin(root, join('packages', 'web', 'dist', 'index.html'));
  if (!manifestPath || !packagePath || !serverPath || !webPath) {
    invalid('desktop_package_incomplete', 'desktop package manifest or built assets are missing');
  }
  const manifest = await boundedJson(manifestPath, 'desktop_package_manifest_invalid');
  const packageInfo = await boundedJson(packagePath, 'desktop_package_manifest_invalid');
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || manifest.id !== 'desktop-local' || manifest.ownership !== 'desktop' || manifest.scope !== 'local-gui'
    || manifest.nna_integration_protocol !== '1.0' || !VERSION.test(manifest.version)
    || packageInfo?.desktop_version !== manifest.version) {
    invalid('desktop_package_manifest_invalid', 'desktop package identity, protocol, or version is incompatible');
  }
  // Compatibility: old registration remains valid; service admission must supply host capabilities.
  if (Object.hasOwn(manifest, 'service_activation') || options.serviceHost !== undefined) {
    await validateDesktopServiceArtifacts(root, manifest, options.serviceHost);
  }
  return Object.freeze({ root, manifestPath, version: manifest.version, protocol: '1.0' });
}

export async function runDesktopPackageCommand(args, paths) {
  const [action, rootInput] = args;
  if (!['activate', 'deactivate', 'status'].includes(action) || args.length !== (action === 'status' ? 1 : 2)) {
    invalid('desktop_package_command_invalid', 'desktop package supports activate ROOT, deactivate ROOT, or status');
  }
  const registry = join(paths.config, REGISTRY_FILE);
  if (action === 'activate') return mutateDesktopPackageRegistration(paths, async ({ lease, snapshot }) => {
    // Invariant: validation describes the package observed after competing registry writers finish.
    const packageInfo = await validateDesktopPackage(rootInput);
    const record = { root: packageInfo.root, version: packageInfo.version, protocol: packageInfo.protocol };
    await transactLockedManifest(lease, { expectedRevision: snapshot.revision, operationId: randomUUID(),
      payload: { action: 'register-desktop-package', record }, transform: () => record, validate: validateRegistration });
    return { registered: true, valid: true, root: packageInfo.root, version: packageInfo.version };
  });
  if (action === 'deactivate') return mutateDesktopPackageRegistration(paths, async ({ stored }) => {
    if (!stored) return { registered: false };
    validateRegistration(stored);
    if (!(await samePackageRoot(rootInput, stored.root))) invalid('desktop_package_root_mismatch', 'Registered desktop package root differs');
    await unlink(registry);
    return { registered: false };
  });
  const stored = await readDesktopPackageRegistration(paths);
  // Status reports registry bytes and package validity only. A selected registration
  // can still be behind the activation-pending barrier with its trial child stopped;
  // an installer must use separate activation evidence before claiming readiness.
  if (!stored) return { registered: false };
  validateRegistration(stored);
  try {
    const current = await validateDesktopPackage(stored.root);
    return { registered: true, valid: current.version === stored.version, root: current.root, version: current.version };
  } catch (error) {
    return { registered: true, valid: false, root: stored.root, version: stored.version, reason: error.code ?? 'desktop_package_invalid' };
  }
}

function validateRegistration(stored) {
  if (typeof stored.root !== 'string' || !isAbsolute(stored.root) || typeof stored.version !== 'string' || !VERSION.test(stored.version) || stored.protocol !== '1.0') {
    invalid('desktop_package_registry_invalid', 'desktop package registry is invalid');
  }
}

export async function assertRegisteredDesktopPackage(rootInput, paths) {
  const status = await runDesktopPackageCommand(['status'], paths);
  if (!status.registered || !status.valid || !(await samePackageRoot(rootInput, status.root))) {
    invalid('desktop_package_not_active', 'Installed desktop package is not the active validated GUI package');
  }
  return status;
}
