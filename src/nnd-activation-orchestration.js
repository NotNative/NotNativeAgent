// SPDX-License-Identifier: Apache-2.0
// Public activation orchestration: the single caller that carries a prepared
// slot through the unpublished trial, the retained-owner terminal sequence, and
// public controller publication. This is the only module allowed to wire the
// trial's final held-live window into the retained-owner publish sequence; the
// publication primitive stays dark until the trial proves durable completion,
// same-process principal promotion, the retirement/clearance chain, and a live
// owner transfer.
import { join } from 'node:path';
import { ContractError } from './ids.js';
import { acquireNndServiceLock } from './nnd-service-lock.js';
import { withManifestLock } from './persistence/manifest-transaction.js';
import { readNndActivationCandidate } from './nnd-activation-candidate.js';
import { runNndUnpublishedTrialUnderOwnership } from './nnd-activation-trial.js';
import { assertNoNndInstallTransaction, operationValid } from './nnd-install-storage.js';
import { assertNoNndInstallMarker } from './nnd-install-marker.js';
import { assertNoNndMigration } from './nnd-migration-storage.js';
import { scanNndLegacyOwners } from './nnd-legacy-census.js';
import { userDataPaths } from './product.js';

const invalid = () => new ContractError('nnd_activation_candidate_invalid',
  'NND public activation requires exact staged and activation operation UUIDs.');
const transition = () => new ContractError('nnd_activation_transition_proof_invalid',
  'NND retained-owner terminal sequence did not reach its expected proof state.');

// Security: only the selected native data root may own the trial, so the trial's
// own path admission check can never be satisfied by caller-shaped paths.
function trialPaths(identity) {
  return userDataPaths({ environment: { NNA_HOME: identity.data_root } });
}

// The final held-live window performs exactly one owned task. It must promote the
// private principal, prove and record the promoted attach, then hand back the
// quarantined owner to the terminal sequence. Each step is ordered so a later
// step cannot observe a missing predecessor proof.
async function runFinalOwnership(context) {
  return context.withFinalOwnership(async finalWindow => {
    const published = await finalWindow.publishSelected();
    if (published?.state !== 'discovery_published_unresolved') throw transition();
    const selected = await finalWindow.selectNativePrincipal();
    if (selected?.state !== 'native_principal_selected_unresolved') throw transition();
    const ticketRecorded = await finalWindow.recordPrivateTicket();
    if (ticketRecorded?.state !== 'private_ticket_recorded_unresolved') throw transition();
    await finalWindow.verifyHeldTicket();
    const promoted = await finalWindow.promotePrivatePrincipal();
    if (promoted?.state !== 'native_principal_promoted_unresolved') throw transition();
    // Invariant: the record step performs the single one-use fresh attach;
    // a separate probe would consume the redemption the receipt requires.
    const recorded = await finalWindow.recordPromotedPrivateAttach();
    if (recorded?.state !== 'promoted_attach_recorded_unresolved') throw transition();
    const owner = finalWindow.retainQuarantinedOwner();
    if (!owner || typeof owner.transferNativeAdmission !== 'function') throw transition();
    return owner;
  });
}

async function finishActivationPostHandoff(owner, registryLease,
  { operationId, stageOperationId, generation, signal, candidateSha256 }) {
  if (!operationValid(generation)) throw invalid();
  const options = { operationId, stageOperationId, generation, signal };
  const published = await driveTerminalSequence(owner, registryLease, options);
  if (published?.state !== 'public_controller_attached') throw transition();
  return Object.freeze({ state: 'public_controller_attached', operation_id: operationId,
    stage_operation_id: stageOperationId, generation: published.generation,
    endpoint: published.endpoint, candidate_sha256: candidateSha256, owner });
}

// Drive the retained owner's terminal sequence in its strict dependency order.
// Completion must precede the retirement plan; the plan precedes the external
// decision; cleanup precedes the terminal commit; the commit precedes barrier
// clearance; clearance precedes native admission transfer; and the controller
// may publish only after the native gate has transferred. Each step re-verifies
// its predecessor under both genuine owners, so none may be skipped or replayed.
async function driveTerminalSequence(owner, registryLease, options) {
  const steps = [
    ['recordCompletion', 'completion_recorded_barred'],
    ['planRetirement', 'retirement_planned_barred'],
    ['recordRetirementDecision', 'retirement_decision_recorded_barred'],
    ['cleanupRetirement', 'retirement_evidence_cleaned_barred'],
    ['commitRetirement', 'terminal_committed_barred'],
    ['clearRetirementBarriers', 'barriers_cleared_admission_barred'],
    ['transferNativeAdmission', 'native_admission_transferred_controller_dark'],
    ['publishController', 'public_controller_attached'],
  ];
  let published = null;
  for (const [method, expected] of steps) {
    if (typeof owner[method] !== 'function') throw transition();
    const result = await owner[method](registryLease, options);
    if (result?.state !== expected) throw transition();
    if (method === 'publishController') published = result;
  }
  return published;
}

/**
 * Activate one prepared immutable slot and publish its live controller.
 *
 * Call order (each step re-verifies the previous durable evidence under both
 * genuine owners, so no step can be replayed or reordered):
 *   trial final window -> terminal sequence (completion through publication)
 *
 * Ownership: the trial transfers the singleton service lease to the retained
 * owner before it returns. This function therefore MUST NOT close that lease;
 * the retained owner closes it when its own stop settles. On a failure before
 * the trial hands off the lease, this function releases the lease it opened.
 * The registry mutex is released when this function's manifest-lock scope exits;
 * ADR 0066 allows that once native admission has transferred.
 *
 * Returns the retained owner handle plus the publication result. A foreground
 * caller keeps the handle alive and awaits `owner.stopped`; a caller that
 * abandons the handle must call `owner.stop()` to release the singleton.
 */
export async function activateNndSlotUnderOwnership(identity, { stageOperationId, operationId, signal } = {}) {
  if (!operationValid(stageOperationId) || !operationValid(operationId)
    || stageOperationId === operationId) throw invalid();
  const paths = trialPaths(identity);
  const serviceLease = await acquireNndServiceLock({ dataRoot: identity.data_root });
  let handedOff = false;
  let retainedOwnerAfterHandoff = null;
  try {
    signal?.throwIfAborted();
    await assertNoNndInstallMarker(identity);
    await assertNoNndInstallTransaction(identity);
    await assertNoNndMigration(identity);
    await scanNndLegacyOwners(identity, signal);
    try {
      return await withManifestLock(join(identity.data_root, 'config', 'nnd-package.json'), { signal },
        async registryLease => {
          // Preflight the immutable slot identity under both owners before the
          // trial may construct any writer. Candidate verification grants no
          // activation or public authority on its own. Retirement cleanup
          // removes the candidate file, so the frame carries its digest.
          const candidate = await readNndActivationCandidate(identity, serviceLease, registryLease, stageOperationId);
          signal?.throwIfAborted();
          const trial = await runNndUnpublishedTrialUnderOwnership(identity, paths, serviceLease,
            registryLease, { stageOperationId, operationId, signal,
              continuation: context => selectRegistrationAfterDiscovery(context, operationId, stageOperationId),
              afterFinalVerification: runFinalOwnership });
          // The trial arms and returns the quarantined owner only after its own
          // lease scope settles, so the terminal sequence re-enters that same
          // singleton lease rather than racing a released one.
          const owner = trial?.owner;
          if (trial?.state !== 'quarantined_owner_held_unresolved' || !owner
            || typeof owner.transferNativeAdmission !== 'function') throw transition();
          // The trial has already transferred the singleton lease to this owner.
          // Any failure from here is post-handoff: the owner, not this function,
          // must release the lease.
          handedOff = true;
          retainedOwnerAfterHandoff = owner;
          const generation = trial?.generation;
          return await finishActivationPostHandoff(owner, registryLease,
            { operationId, stageOperationId, generation, signal, candidateSha256: candidate.evidence_sha256 });
        });
    } catch (error) {
      // Owner: any post-handoff error, including later registry-cleanup
      // failure, must run the retained owner's exact stop protocol before the
      // error escapes, otherwise the sole live generation would be stranded.
      try { await retainedOwnerAfterHandoff?.stop(); }
      catch (stopError) {
        throw new AggregateError([error, stopError],
          'NND activation failure and retained-owner shutdown failed');
      }
      throw error;
    }
  } finally {
    // Invariant: after the retained handoff the owner owns the singleton lease
    // and closes it when its own stop settles. Only a pre-handoff failure may
    // release the lease this function opened; calling close twice would drop a
    // live generation's ownership.
  if (!handedOff) await serviceLease.close();
  }
}

async function selectRegistrationAfterDiscovery(context, operationId, stageOperationId) {
  await context.prepareDiscovery();
  return context.selectRegistration({ operationId, stageOperationId });
}
