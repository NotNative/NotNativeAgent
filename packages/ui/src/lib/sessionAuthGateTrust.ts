// SPDX-License-Identifier: Apache-2.0
/**
 * "Trust this device" persistence for the SessionAuthGate (doc 08 §6.6 step 2).
 *
 * This is a leaf module on purpose: the probe half (`sessionAuthGateState.ts`),
 * the view half (`sessionAuthGateView.ts`) and the component all need it, and
 * the spec-named state file must not import the view file it feeds.
 *
 * Per §6.6 the checkbox is a *browser* preference only - the session TTL stays
 * the server's decision, sent as `trustDevice` on the login body. Nothing here
 * reads or writes a credential.
 */
import type { SimpleStore } from './sessionAuthGateState.ts';

/** §6.6 step 2: the checkbox is a browser preference; the TTL is the server's.
 *  NND brand per NOTES/01 §Auth gate (reference used openchamber.). */
export const TRUST_DEVICE_STORAGE_KEY = 'notnative.uiAuth.trustDevice';

/**
 * The one capability this module needs, spelled structurally so it stays a leaf:
 * `SessionGateRuntime` satisfies it without either file importing the other's
 * value exports.
 */
export interface TrustDeviceHost {
  storage(): SimpleStore | undefined;
}

export function readTrustDevice(runtime: TrustDeviceHost): boolean {
  const store = runtime.storage();
  if (store === undefined) return false;
  try {
    return store.getItem(TRUST_DEVICE_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/** A `false` answer removes the key instead of storing a noisy literal false. */
export function rememberTrustDevice(runtime: TrustDeviceHost, trusted: boolean): void {
  const store = runtime.storage();
  if (store === undefined) return;
  try {
    if (trusted) store.setItem(TRUST_DEVICE_STORAGE_KEY, 'true');
    else store.removeItem(TRUST_DEVICE_STORAGE_KEY);
  } catch {
    // Disabled or private storage: the checkbox stays advisory.
  }
}
