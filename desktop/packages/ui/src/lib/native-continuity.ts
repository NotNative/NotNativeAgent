// SPDX-License-Identifier: Apache-2.0
let resume: { runtime: string; sessionId: string; directory: string } | null = null;
let restoringRuntime: string | null = null;
let outcome = 'none';
export const nativeContinuityOutcome = () => outcome;
export function recordNativeContinuityOutcome(value: string): void { outcome = value; publish(); }
const listeners = new Set<() => void>();
const publish = () => { for (const listener of listeners) listener(); };
export const subscribeNativeContinuity = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const nativeContinuityPending = (runtime: string) => resume?.runtime === runtime || restoringRuntime === runtime;
export function finishNativeContinuity(runtime: string): void {
  if (resume?.runtime === runtime) resume = null;
  if (restoringRuntime === runtime) restoringRuntime = null;
  publish();
}
export function takeNativeResumeSelection(runtime: string) {
  const selected = resume; resume = null;
  if (selected?.runtime === runtime) restoringRuntime = runtime;
  return selected?.runtime === runtime ? selected : null;
}
/** Restore only this verified installation's presentation cache, before any store reads it. */
export function restoreNativeContinuity(value: unknown, runtime: string): void {
  if (value === null || value === undefined) return;
  const snapshot = value as { runtime?: unknown; drafts?: unknown; lastSession?: unknown };
  if (!snapshot || snapshot.runtime !== runtime || typeof snapshot.drafts !== 'string' || typeof snapshot.lastSession !== 'string'
    || new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > 4 * 1024 * 1024) throw new Error('Invalid desktop continuity cache.');
  const drafts = JSON.parse(snapshot.drafts), last = JSON.parse(snapshot.lastSession);
  if (!drafts || typeof drafts !== 'object' || Array.isArray(drafts) || Object.keys(drafts).length > 512
    || Object.keys(drafts).some(key => !key.startsWith(`${runtime}\n`))
    || last?.version !== 1 || !last.runtimes || typeof last.runtimes !== 'object' || Array.isArray(last.runtimes)
    || Object.keys(last.runtimes).some(key => key !== runtime)) throw new Error('Invalid desktop continuity cache.');
  // Invariant: cached selections and pending-send identities still require their native owners' checks.
  localStorage.setItem('nnd.draft.v1', JSON.stringify(drafts));
  localStorage.setItem('nnd.lastSession.v1', JSON.stringify(last));
  const selected = last.runtimes[runtime];
  resume = typeof selected?.sessionId === 'string' && selected.sessionId.length > 0 && selected.sessionId.length <= 256
    && typeof selected.directory === 'string' && selected.directory.length > 0 && selected.directory.length <= 4096
    ? { runtime, sessionId: selected.sessionId, directory: selected.directory } : null;
  outcome = resume ? 'pending' : 'no-selection';
  publish();
}
