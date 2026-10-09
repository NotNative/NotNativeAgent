// SPDX-License-Identifier: Apache-2.0
/** Consume the post-publication proof into the native listener's selection latch. */
import { ContractError } from './ids.js';
import { withNndServiceLease } from './nnd-service-lock.js';
import { runManifestLeaseWork } from './persistence/manifest-lock.js';
import { verifyNndPublishedTrialHealthUnderOwnership } from './nnd-activation-post-publication-health.js';
const invalid = () => new ContractError('nnd_activation_transition_proof_invalid',
  'NND native principal selection is unresolved; preserve the activation barrier and both owners.');
const liveState = (state, options) => {
  if (!state || state.published !== false || state.stopping || state.registrationSelected !== true
    || state.child?.failed || !state.child?.child || state.child.child.exitCode !== null
    || state.record?.instance_id !== options.generation
    || typeof state.native?.selectTrialPrincipal !== 'function') throw invalid();
};

// Security: ADR 0047 keeps the trial principal authority limited until the
// same-process selection latch exists. The proof is consumed synchronously
// inside the verified callback and the listener latches before any await, so
// an async callback or a changed listener can never widen the trial gate.
export async function selectNndNativePrincipalUnderOwnership(identity, state, serviceLease, registryLease, options = {}) {
  if (!identity || Object.keys(options).some(key =>
    !['operationId', 'stageOperationId', 'generation', 'signal'].includes(key))) throw invalid();
  liveState(state, options);
  if (state.native.selectedPrincipalEvidence?.(state)) {
    throw invalid();
  }
  return withNndServiceLease(serviceLease, identity.data_id,
    leaseSignal => runManifestLeaseWork(registryLease, async () => {
      const signal = AbortSignal.any([leaseSignal, AbortSignal.timeout(180000),
        ...(options.signal ? [options.signal] : [])]);
      let selected;
      try {
        const health = await verifyNndPublishedTrialHealthUnderOwnership(identity, state, serviceLease, registryLease,
          { ...options, signal, afterVerified: ({ proof }) => {
            selected = state.native.selectTrialPrincipal(proof, state, serviceLease, registryLease, options);
            if (!selected || selected.operation_id !== options.operationId
              || selected.stage_operation_id !== options.stageOperationId
              || selected.generation !== options.generation) throw invalid();
          } });
        if (!selected) throw invalid();
        return Object.freeze({ state: 'native_principal_selected_unresolved',
          operation_id: options.operationId, stage_operation_id: options.stageOperationId,
          generation: options.generation, registration_revision: selected.registration_revision,
          journal_sha256: selected.journal_sha256, native_state: health.native_state });
      } catch { throw invalid(); }
      finally { selected = null; }
    }), { timeoutMs: 300000 });
}
