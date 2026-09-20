// SPDX-License-Identifier: Apache-2.0
/**
 * SessionAuthGate presentation helpers (doc 08 §6.6 steps 2 and 6). Split out
 * of `sessionAuthGateState.ts` so the probe/payload half stays under the
 * file-length gate; nothing here talks to `/auth/session`.
 *
 * Two concerns live here:
 * - the "trust this device" browser preference, which is storage-only; and
 * - the single mapping from (probe, local support, passkey presence) to the
 *   affordances the component is allowed to render, so the component cannot
 *   invent a stage of its own.
 */
import { useAuthSessionStore } from './runtime-auth-expiry.ts';
import {
  getPasskeySupportState,
  type PasskeySupportState,
} from './passkeys.ts';
import { listPasskeys } from './passkeys.ts';
import {
  formatRetryAfterLine,
  probeSessionGateWithRetries,
  UNKNOWN_PRESENCE,
  type PasskeyPresence,
  type SessionGateRuntime,
  type SessionGateView,
  type SessionProbe,
} from './sessionAuthGateState.ts';
// "Trust this device" lives in `sessionAuthGateTrust.ts` (a leaf both this file
// and the probe half can import without a cycle).

// ---------------------------------------------------------------------------
// Passkey presence
// ---------------------------------------------------------------------------

/**
 * §6.6 step 2 needs `enabled && hasPasskeys`. `enabled` is local support
 * (§2.5); `hasPasskeys` only comes from `GET /api/passkeys`, which requires a
 * session. A locked or unreachable host yields `known:false` — the "Use
 * passkey" button is withheld, not shown against a host we cannot ask.
 */
export async function fetchPasskeyPresence(
  runtime: SessionGateRuntime,
): Promise<PasskeyPresence> {
  const listed = await listPasskeys(runtime);
  // `passkeysDisabled` is already derived from the response error text by
  // `actionFailure` (passkeys-support.ts), so a second text probe would be
  // dead code.
  if (listed.passkeysDisabled === true) {
    return { known: false, hasPasskeys: false, passkeysDisabled: true };
  }
  if (listed.ok !== true) {
    return { known: false, hasPasskeys: false, passkeysDisabled: false };
  }
  return {
    known: true,
    hasPasskeys: listed.passkeys.length > 0,
    passkeysDisabled: false,
    rpID: listed.rpID,
  };
}

// ---------------------------------------------------------------------------
// View derivation
// ---------------------------------------------------------------------------

/**
 * The single mapping from (probe, local support, passkey presence) to rendered
 * affordances. Exported so the component cannot drift from the tested logic.
 */
export function sessionGateView(
  probe: SessionProbe,
  support: PasskeySupportLike,
  presence: PasskeyPresence,
): SessionGateView {
  const enabled = support.level === 'available';
  const view: SessionGateView = {
    stage: probe.stage,
    authRequired: probe.authRequired,
    passwordForm: false,
    passkeyUnlock: false,
    passkeyEnroll: false,
    passkeysDisabledHint: false,
    tunnelExplanation: false,
    retryable: false,
    retryLine: null,
  };
  if (probe.stage === 'tunnel-locked') {
    // §2.9: password login is refused at tunnel scope. The only route in is a
    // one-time connect token, so no credential field may be rendered.
    view.tunnelExplanation = true;
    view.retryable = true;
    return view;
  }
  if (probe.stage === 'rate-limited') {
    view.retryLine = formatRetryAfterLine(probe.retryAfterSeconds);
    view.retryable = true;
    view.passkeyUnlock = presence.hasPasskeys === true && enabled === true;
    return view;
  }
  if (probe.stage === 'error') {
    view.retryable = true;
    view.retryLine = probe.error ?? probe.detail ?? null;
    return view;
  }
  if (probe.stage !== 'locked') return view;

  view.passwordForm = probe.methods.length === 0 || probe.methods.includes('password');
  view.passkeyUnlock = presence.hasPasskeys === true && enabled === true;
  view.passkeyEnroll = enabled === true && presence.known === true && presence.hasPasskeys === false;
  view.passkeysDisabledHint = presence.passkeysDisabled === true;
  return view;
}

/** Local passkey support, narrowed to the one field the view reads. */
export type PasskeySupportLike = { level: 'unsupported' | 'unavailable' | 'available' };

/** Convenience for callers that only branch on "is the gate open?". */
export function gateIsOpen(probe: SessionProbe): boolean {
  return probe.stage === 'authenticated';
}

/** True while the shared store believes the session died mid-session (§6.7). */
export function gateSessionIsExpired(): boolean {
  return useAuthSessionStore.getState().status === 'expired';
}

export const NO_SUPPORT: PasskeySupportState = {
  level: 'unsupported',
  secureContext: false,
  webauthn: false,
  passkeys: false,
};

export async function readSupportState(runtime: SessionGateRuntime): Promise<PasskeySupportState> {
  try {
    return await getPasskeySupportState(runtime);
  } catch {
    return NO_SUPPORT;
  }
}

interface GateSetters {
  setPasswordValue(value: string): void;
  setInlineError(value: string | null): void;
  setBusy(value: 'none' | 'submit' | 'passkey'): void;
  setPresence(presence: PasskeyPresence): void;
  setSupport(support: PasskeySupportState | null): void;
  setProbe(probe: SessionProbe): void;
}

/**
 * One full §6.6.1 cycle: cancel ceremonies, clear every input, then probe with
 * the bounded retry ladder. A superseded generation publishes nothing — the
 * reply from an older probe is dropped where the newer one already answered.
 */
export async function resetGateAndProbe(
  runtime: SessionGateRuntime,
  generation: { current: number },
  setters: GateSetters,
): Promise<void> {
  const mine = generation.current + 1;
  generation.current = mine;
  runtime.abortService.cancelCeremony();
  setters.setPasswordValue('');
  setters.setInlineError(null);
  setters.setBusy('none');
  setters.setPresence(UNKNOWN_PRESENCE);
  setters.setSupport(await readSupportState(runtime));
  const outcome = await probeSessionGateWithRetries(runtime);
  if (generation.current !== mine) return;
  setters.setProbe(outcome);
  // Presence needs a live session: `GET /api/passkeys` answers 401 for a
  // locked visitor, so `known:false` there is honest, not a cached guess.
  if (outcome.stage === 'authenticated') {
    const listed = await fetchPasskeyPresence(runtime);
    if (generation.current === mine) setters.setPresence(listed);
  }
}
