// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { ContractError } from './ids.js';
import { acquireDesktopServiceLock } from './desktop-service-lock.js';
import { withManifestLock } from './persistence/manifest-transaction.js';
import { readDesktopActivationCandidate } from './desktop-activation-candidate.js';
import { recoverDesktopActivationPreparation } from './desktop-activation-preparation.js';
import { activateDesktopSlotUnderOwnership } from './desktop-activation-orchestration.js';
import { assertNoDesktopInstallTransaction, operationValid } from './desktop-install-storage.js';
import { assertNoDesktopInstallMarker } from './desktop-install-marker.js';
import { assertNoDesktopMigration } from './desktop-migration-storage.js';
import { scanDesktopLegacyOwners } from './desktop-legacy-census.js';

const invalid = () => new ContractError('desktop_activation_candidate_invalid',
  'desktop activation requires exact staged and activation operation UUIDs.');

/** Check immutable slot identity under both native owners without preparing or publishing it. */
export async function preflightDesktopActivation(identity, { stageOperationId, operationId, signal } = {}) {
  if (!operationValid(stageOperationId) || !operationValid(operationId)
    || stageOperationId === operationId) throw invalid();
  const lease = await acquireDesktopServiceLock({ dataRoot: identity.data_root });
  try {
    signal?.throwIfAborted();
    await assertNoDesktopInstallMarker(identity);
    await assertNoDesktopInstallTransaction(identity);
    await assertNoDesktopMigration(identity);
    await scanDesktopLegacyOwners(identity, signal);
    return await withManifestLock(join(identity.data_root, 'config', 'desktop-package.json'), { signal }, async registryLease => {
      const candidate = await readDesktopActivationCandidate(identity, lease, registryLease, stageOperationId);
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
export async function recoverDesktopActivationPreparationCommand(identity, { operationId } = {}) {
  if (!operationValid(operationId)) throw invalid();
  return recoverDesktopActivationPreparation(identity, { operationId });
}

/**
 * Activate one prepared slot end to end and then serve its published controller
 * in the foreground.
 *
 * Compatibility: this command must not be reachable except through the exact
 * prepared stage UUID and activation UUID pair; the orchestrator re-validates
 * them and the trial re-derives the prepared receipt from the journal.
 *
 * Lifetime: ADR 0068 requires the activation process to outlive the invoking
 * client. This command writes the public readiness frame and then stays attached,
 * holding the singleton service lease through the retained owner, until the
 * process is signalled or the owner's own stop settles. It never returns while
 * the sole live generation is unheld.
 */
export async function activateDesktopSlotCommand(identity, { stageOperationId, operationId, signal, output } = {}) {
  if (!operationValid(stageOperationId) || !operationValid(operationId)
    || stageOperationId === operationId) throw invalid();
  const result = await activateDesktopSlotUnderOwnership(identity, { stageOperationId, operationId, signal });
  const { owner, ...published } = result;
  const stop = () => { void owner.stop().catch(() => {}); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  try {
    (output ?? process.stdout).write(`${JSON.stringify(published)}\n`);
  } catch (error) {
    // Output: a local write failure must not be able to strand the sole live
    // retained generation. The registered signal handlers remain installed
    // during the bounded stop, then uninstall them on the way out.
    try { await owner.stop(); }
    catch (stopError) {
      throw new AggregateError([error, stopError],
        'desktop activation output write and retained-owner shutdown failed');
    }
    throw error;
  }
  try {
    const outcome = await owner.stopped;
    if (outcome?.error) throw outcome.error;
    return { stopped: true };
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    signal?.removeEventListener('abort', stop);
  }
}
