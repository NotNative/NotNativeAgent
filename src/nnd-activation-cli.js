// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { ContractError } from './ids.js';
import { acquireNndServiceLock } from './nnd-service-lock.js';
import { withManifestLock } from './persistence/manifest-transaction.js';
import { readNndActivationCandidate } from './nnd-activation-candidate.js';
import { recoverNndActivationPreparation } from './nnd-activation-preparation.js';
import { assertNoNndInstallTransaction, operationValid } from './nnd-install-storage.js';
import { assertNoNndInstallMarker } from './nnd-install-marker.js';
import { assertNoNndMigration } from './nnd-migration-storage.js';
import { scanNndLegacyOwners } from './nnd-legacy-census.js';

const invalid = () => new ContractError('nnd_activation_candidate_invalid',
  'NND activation requires exact staged and activation operation UUIDs.');

/** Check immutable slot identity under both native owners without preparing or publishing it. */
export async function preflightNndActivation(identity, { stageOperationId, operationId, signal } = {}) {
  if (!operationValid(stageOperationId) || !operationValid(operationId)
    || stageOperationId === operationId) throw invalid();
  const lease = await acquireNndServiceLock({ dataRoot: identity.data_root });
  try {
    signal?.throwIfAborted();
    await assertNoNndInstallMarker(identity);
    await assertNoNndInstallTransaction(identity);
    await assertNoNndMigration(identity);
    await scanNndLegacyOwners(identity, signal);
    return await withManifestLock(join(identity.data_root, 'config', 'nnd-package.json'), { signal }, async registryLease => {
      const candidate = await readNndActivationCandidate(identity, lease, registryLease, stageOperationId);
      signal?.throwIfAborted();
      // Invariant: candidate verification grants no activation or public authority.
      return Object.freeze({ state: 'slot_ready', operation_id: operationId,
        stage_operation_id: stageOperationId, installation_id: identity.installation_id,
        data_id: identity.data_id, version: candidate.evidence.version,
        payload_sha256: candidate.evidence.payload_sha256,
        candidate_sha256: candidate.evidence_sha256 });
    });
  } finally {
    await lease.close();
  }
}

/** Reconcile only the preparation prefix; later trial/retirement phases remain barred. */
export async function recoverNndActivationPreparationCommand(identity, { operationId } = {}) {
  if (!operationValid(operationId)) throw invalid();
  return recoverNndActivationPreparation(identity, { operationId });
}
