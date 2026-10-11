// SPDX-License-Identifier: Apache-2.0
/** Capability lifecycle for the supervised NND service child (execution guide
 *  02 L3): the supervisor issues a generation-bound capability at bootstrap
 *  and pushes a fresh one over the private control channel before expiry. A
 *  failed renewal fails the session so privileged work never continues on
 *  stale authority, and the capability dies with the supervisor. */
import { createCapabilityAuthority } from './integration-capability.js';

const CAPABILITY_RENEW_MS = 5 * 60 * 1000;

export function createNndServiceCapabilityAuthority(identity, generation) {
  return createCapabilityAuthority({
    generation,
    principal: {
      subject_id: `nnd-service:${identity.installation_id}`, platform_role: 'service',
      permissions: ['harness.proxy'], workspace_ids: [], group_ids: [],
    },
  });
}

export function bootstrapCapability(state) {
  return state.capabilityAuthority.issue();
}

/** Arm the renewal timer: a failed push fails the session via the returned
 *  stop hook, and callers clear the timer when closing the supervisor. */
export function armCapabilityRenewal(state, { stop }) {
  const push = async () => {
    if (state.stopping || state.child?.failed) return;
    try {
      await state.child.command('apply_capability', { capability: state.capabilityAuthority.issue() });
      state.renewTimer = setTimeout(() => { void push(); }, CAPABILITY_RENEW_MS);
      state.renewTimer.unref?.();
    } catch (error) {
      state.failure = error; // the session must not keep serving on stale authority
      try { await stop(); } catch { /* stop failures are recorded by the supervisor's own path */ }
    }
  };
  state.renewTimer = setTimeout(() => { void push(); }, CAPABILITY_RENEW_MS);
  state.renewTimer.unref?.();
}

export function clearCapabilityRenewal(state) {
  clearTimeout(state.renewTimer); // the capability dies with the supervisor
}
