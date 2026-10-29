// SPDX-License-Identifier: Apache-2.0
import { isAbsolute, join, resolve } from 'node:path';
import { mkdir, realpath } from 'node:fs/promises';
import { ContractError } from './ids.js';
import { readManifestSnapshot, readLockedManifestSnapshot, withManifestLock } from './persistence/manifest-transaction.js';
import { assertNoDesktopInstallTransaction } from './desktop-install-storage.js';

export function registrationDocument(snapshot) {
  if (snapshot.state === 'missing') return null;
  const stored = snapshot.rawManifest;
  if (snapshot.rawBytes.length > 16384 || !stored || typeof stored !== 'object' || Array.isArray(stored)) {
    throw new ContractError('desktop_package_registry_invalid', 'desktop package registry is not a bounded JSON object; existing bytes were preserved');
  }
  return stored;
}

export async function readDesktopPackageRegistration(paths) {
  try { return registrationDocument(await readManifestSnapshot(join(paths.config, 'desktop-package.json'))); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function mutateDesktopPackageRegistration(paths, operation) {
  const invalidRoot = () => new ContractError('desktop_package_data_root_invalid',
    'desktop package mutation requires a data root paired with its config directory');
  const samePath = (left, right) => process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase() : left === right;
  if (typeof paths?.root !== 'string' || !isAbsolute(paths.root)
    || typeof paths.config !== 'string' || !isAbsolute(paths.config)
    || !samePath(resolve(paths.config), resolve(paths.root, 'config'))) throw invalidRoot();
  const root = await realpath(paths.root).catch(() => { throw invalidRoot(); });
  await mkdir(paths.config, { recursive: true, mode: 0o700 });
  const config = await realpath(paths.config).catch(() => { throw invalidRoot(); });
  if (!samePath(config, join(root, 'config'))) throw invalidRoot();
  const path = join(paths.config, 'desktop-package.json');
  return withManifestLock(path, {}, async lease => {
    // Security: all mutations check the selected data root under the registry lock.
    await assertNoDesktopInstallTransaction({ data_root: paths.root });
    const snapshot = await readLockedManifestSnapshot(lease);
    return operation({ lease, path, snapshot, stored: registrationDocument(snapshot) });
  });
}
