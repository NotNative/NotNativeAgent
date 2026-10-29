// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { verifyDesktopClearedAdmissionUnderOwnership } from './desktop-activation-retirement-cleanup.js';
import { requestDesktopController } from './desktop-service-controller.js';

const invalid = () => new ContractError('desktop_activation_public_controller_invalid',
  'desktop public controller activation is unresolved; preserve the retained owner and cleared witness.');

/** Publish only the already selected live controller, then prove ordinary attach over HTTP. */
export async function publishRetainedDesktopController(state, registryLease, options) {
  if (!state?.unpublishedTrial || !state.retained || !state.retainedLeaseArmed
    || !state.nativeAdmissionTransferred || state.published || state.publicationAttempted
    || state.stopping || !state.controller?.isListening?.() || !state.native?.isListening?.()) throw invalid();
  // Invariant: a failed attach probe is unresolved. Do not expose this controller again by retrying a
  // same-process method whose public ticket might have escaped before the failure was observed.
  state.publicationAttempted = true;
  try {
    await verifyDesktopClearedAdmissionUnderOwnership(state.identity, state, state.lease,
      registryLease, options, () => {
        if (!state.nativeAdmissionTransferred || state.published || state.stopping
          || !state.controller?.isListening?.() || !state.native?.isListening?.()) throw invalid();
        // No await separates the final owned proof and controller visibility.
        state.published = true;
      });
    const attached = await requestDesktopController(state.record, 'attach');
    if (!state.published || state.stopping || !state.controller?.isListening?.()
      || !state.native?.isListening?.() || attached.generation !== state.record.instance_id) throw invalid();
    return Object.freeze({ state: 'public_controller_attached',
      operation_id: state.activationOperationId, generation: state.record.instance_id,
      endpoint: attached.endpoint });
  } catch (cause) {
    state.published = false;
    throw new ContractError('desktop_activation_public_controller_invalid', invalid().message, { cause });
  }
}
