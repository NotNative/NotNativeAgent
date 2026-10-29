// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { probeDesktopLegacyOwners } from './desktop-legacy-census.js';

export const DESKTOP_TAKEOVER_DRAIN_WINDOW_MS = 60000;
export const DESKTOP_TAKEOVER_DRAIN_INTERVAL_MS = 2000;

function abortableSleep(signal, intervalMs) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const finish = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(finish, intervalMs);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

// ADR 0071: discovery, bounded wait, verification. Never terminates a process.
export async function drainDesktopLegacyTakeover(identity, signal, options = {}) {
  const windowMs = options.windowMs ?? DESKTOP_TAKEOVER_DRAIN_WINDOW_MS;
  const intervalMs = options.intervalMs ?? DESKTOP_TAKEOVER_DRAIN_INTERVAL_MS;
  if (!Number.isSafeInteger(windowMs) || windowMs < 0 || windowMs > 600000
    || !Number.isSafeInteger(intervalMs) || intervalMs < 250 || intervalMs > 30000) {
    throw new ContractError('desktop_legacy_takeover_required', 'Legacy takeover drain parameters are invalid');
  }
  const deadline = Date.now() + windowMs;
  for (;;) {
    let probe;
    try { probe = await probeDesktopLegacyOwners(identity, signal); }
    // A lease abort is ownership loss, not an unverified census: the reason must propagate.
    catch (error) { if (signal.aborted) throw signal.reason ?? error; throw error; }
    if (probe.legacy === 0 && probe.unknown === 0) {
      return Object.freeze({ version: '1.0', scanned: probe.scanned, legacy: 0, unknown: 0,
        checked_at: new Date().toISOString() });
    }
    if (Date.now() >= deadline) {
      const owners = [...probe.unknown_pids, ...probe.legacy_pids].join(', ');
      throw new ContractError('desktop_legacy_takeover_required',
        `Legacy or unverifiable desktop processes still own the state (pids ${owners}). Exit the legacy desktop desktop or "nna desktop serve" cleanly, then rerun. No process was terminated.`);
    }
    await abortableSleep(signal, Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  }
}
