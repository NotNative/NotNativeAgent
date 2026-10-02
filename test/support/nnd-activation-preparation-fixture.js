// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { lstat, opendir, rmdir, unlink, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ContractError } from '../../src/ids.js';
import { acquireNndServiceLock, assertHeldNndServiceLease, withNndServiceLease } from '../../src/nnd-service-lock.js';
import { withManifestLock, readLockedManifestSnapshot } from '../../src/persistence/manifest-transaction.js';
import { assertManifestLease, runManifestLeaseWork } from '../../src/persistence/manifest-lock.js';
import { runPrivateWindowsProgram, PRIVATE_ACL_PROGRAM } from '../../src/nnd-service-private-windows.js';
import { assertNoNndInstallMarker } from '../../src/nnd-install-marker.js';
import { openInstallStore, readInstallBytes, writeInstallNew, json, hash, operationValid } from '../../src/nnd-install-storage.js';
import { withActivationInitialization } from '../../src/nnd-activation-initialization-db.js';
import { readNndActivationJournal, nndPreparedPhaseBytes } from '../../src/nnd-activation-journal.js';
import { exactRecord } from '../../src/nnd-service-contract.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const registry = identity => join(identity.data_root, 'config', 'nnd-package.json');
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
    acquireNndServiceLock, assertHeldNndServiceLease, withNndServiceLease, assertManifestLease, runManifestLeaseWork,
    withManifestLock, readLockedManifestSnapshot,
    runPrivateWindowsProgram, PRIVATE_ACL_PROGRAM, assertNoNndInstallMarker,
    assertNoNndMigration: async () => {}, scanNndLegacyOwners: async () => ({}),
    openInstallStore, read: readInstallBytes, write: writeInstallNew, json, hash, operationValid,
    withActivationInitialization, readNndActivationCandidate: async (_identity, _lease, _registry, stageId) =>
      mockedCandidate(identity, stageId),
    readNndPreparedActivationCandidate: async (_identity, _lease, _registry, stageId, marker) => {
      const actual = await readInstallBytes(join(identity.data_root, 'runtime', 'nnd', 'installation-pending.json'), 1024);
      if (!actual.equals(marker)) throw new Error('Marker mismatch');
      return mockedCandidate(identity, stageId);
    },
    readNndActivationJournal, nndPreparedPhaseBytes, exactRecord };
  const source = await readFile(new URL('../../src/nnd-activation-preparation.js', import.meta.url), 'utf8');
  const executable = source.replace(/^import\s[\s\S]*?;\r?\n/gm, '')
    .replaceAll('export async function', 'async function');
  return Function(...Object.keys(dependencies), executable
    + '\nreturn { prepareNndActivation, prepareNndActivationUnderOwnership, recoverNndActivationPreparation };')(...Object.values(dependencies));
}
export async function identityFor(root, installRoot) {
  const data = await realpath(root), install = await realpath(installRoot);
  return { data_root: data, install_root: install, data_id: `data_${sha(data.toLowerCase())}`,
    installation_id: `nna_${sha(install.toLowerCase())}`, platform: 'win32', architecture: 'x64', node_major: Number(process.versions.node.split('.')[0]) };
}
