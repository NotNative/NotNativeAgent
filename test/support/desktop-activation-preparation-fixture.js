// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { lstat, opendir, rmdir, unlink, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ContractError } from '../../src/ids.js';
import { acquireDesktopServiceLock, assertHeldDesktopServiceLease, withDesktopServiceLease } from '../../src/desktop-service-lock.js';
import { withManifestLock, readLockedManifestSnapshot } from '../../src/persistence/manifest-transaction.js';
import { assertManifestLease, runManifestLeaseWork } from '../../src/persistence/manifest-lock.js';
import { runPrivateWindowsProgram, PRIVATE_ACL_PROGRAM } from '../../src/desktop-service-private-windows.js';
import { assertNoDesktopInstallMarker } from '../../src/desktop-install-marker.js';
import { openInstallStore, readInstallBytes, writeInstallNew, json, hash, operationValid } from '../../src/desktop-install-storage.js';
import { withActivationInitialization } from '../../src/desktop-activation-initialization-db.js';
import { readDesktopActivationJournal, desktopPreparedPhaseBytes } from '../../src/desktop-activation-journal.js';
import { exactRecord } from '../../src/desktop-service-contract.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const registry = identity => join(identity.data_root, 'config', 'desktop-package.json');
async function mockedCandidate(identity, stageOperationId) {
  let before;
  try { before = await readFile(registry(identity)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const evidence = { protocol: '2.0', stage_operation_id: stageOperationId,
    installation_id: identity.installation_id, data_id: identity.data_id, version: '20261002-8',
    payload_sha256: sha('fixture payload'), stage_prepared_sha256: sha('stage prepared'),
    stage_ready_sha256: sha('stage ready'), provenance_sha256: sha('provenance'),
    slot_ino: '10', slot_dev: '20', registry_before_revision: before ? sha(before) : 'absent',
    desired_registration_sha256: sha('desired registration') };
  return { evidence, evidence_sha256: hash(json(evidence)), package: { version: '20261002-8' } };
}
export async function preparationHarness(identity) {
  const dependencies = { lstat, opendir, rmdir, unlink, join, resolve, ContractError,
    acquireDesktopServiceLock, assertHeldDesktopServiceLease, withDesktopServiceLease, assertManifestLease, runManifestLeaseWork,
    withManifestLock, readLockedManifestSnapshot,
    runPrivateWindowsProgram, PRIVATE_ACL_PROGRAM, assertNoDesktopInstallMarker,
    assertNoDesktopMigration: async () => {}, scanDesktopLegacyOwners: async () => ({}),
    openInstallStore, read: readInstallBytes, write: writeInstallNew, json, hash, operationValid,
    withActivationInitialization, readDesktopActivationCandidate: async (_identity, _lease, _registry, stageId) =>
      mockedCandidate(identity, stageId),
    readDesktopPreparedActivationCandidate: async (_identity, _lease, _registry, stageId, marker) => {
      const actual = await readInstallBytes(join(identity.data_root, 'runtime', 'desktop', 'installation-pending.json'), 1024);
      if (!actual.equals(marker)) throw new Error('Marker mismatch');
      return mockedCandidate(identity, stageId);
    },
    readDesktopActivationJournal, desktopPreparedPhaseBytes, exactRecord };
  const source = await readFile(new URL('../../src/desktop-activation-preparation.js', import.meta.url), 'utf8');
  const executable = source.replace(/^import\s[\s\S]*?;\r?\n/gm, '')
    .replaceAll('export async function', 'async function');
  return Function(...Object.keys(dependencies), executable
    + '\nreturn { prepareDesktopActivation, prepareDesktopActivationUnderOwnership, recoverDesktopActivationPreparation };')(...Object.values(dependencies));
}
export async function identityFor(root, installRoot) {
  const data = await realpath(root), install = await realpath(installRoot);
  return { data_root: data, install_root: install, data_id: `data_${sha(data.toLowerCase())}`,
    installation_id: `nna_${sha(install.toLowerCase())}`, platform: 'win32', architecture: 'x64', node_major: Number(process.versions.node.split('.')[0]) };
}
