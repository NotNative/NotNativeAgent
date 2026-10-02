// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { ContractError } from './ids.js';
import { readManifestSnapshot, readLockedManifestSnapshot, withManifestLock } from './persistence/manifest-transaction.js';
import { assertNoNndInstallTransaction } from './nnd-install-storage.js';

export function registrationDocument(snapshot) {
  if (snapshot.state === 'missing') return null;
  const stored = snapshot.rawManifest;
  if (snapshot.rawBytes.length > 16384 || !stored || typeof stored !== 'object' || Array.isArray(stored)) {
    throw new ContractError('nnd_package_registry_invalid', 'NND package registry is not a bounded JSON object; existing bytes were preserved');
  }
  return stored;
}

export async function readNndPackageRegistration(paths) {
  try { return registrationDocument(await readManifestSnapshot(join(paths.config, 'nnd-package.json'))); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function mutateNndPackageRegistration(paths, operation) {
  await mkdir(paths.config, { recursive: true, mode: 0o700 });
  const path = join(paths.config, 'nnd-package.json');
  return withManifestLock(path, {}, async lease => {
    // Security: the CLI always supplies the selected data root; detached registry adapters share the file mutex.
    if (paths.root) await assertNoNndInstallTransaction({ data_root: paths.root });
    const snapshot = await readLockedManifestSnapshot(lease);
    return operation({ lease, path, snapshot, stored: registrationDocument(snapshot) });
  });
}
