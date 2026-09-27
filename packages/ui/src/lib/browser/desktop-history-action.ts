// SPDX-License-Identifier: Apache-2.0
/** Exact-observation navigation of the isolated desktop guest's own history. */
export interface HistoryPending { fromGuest: HTMLElement; target: string }
type PendingRef = { current: HistoryPending | null };
type HistoryGuest = HTMLElement & { getURL?: () => string; isLoading?: () => boolean };

export function historyNavigationPending(pending: PendingRef, guest: HTMLElement | null, currentUrl: string | undefined): boolean {
  const action = pending.current;
  if (!action) return false;
  // A cached replacement can finish before the passive listener attaches.
  // A destroyed or still-loading guest is never evidence of completion.
  try {
    const current = guest as HistoryGuest | null;
    if (current && current !== action.fromGuest && current.getURL?.() === currentUrl
      && current.isLoading?.() === false) pending.current = null;
  } catch { /* keep the pending action fail-closed */ }
  return Boolean(pending.current);
}

export function executeDesktopHistory(parameters: Record<string, unknown>, context: {
  guest: HTMLElement | null; history: string[]; index: number; revision: number; observationId: string | null;
  pending: PendingRef; otherPending: () => boolean; move: (delta: number) => void;
}): { direction: string; urlBefore: string; targetUrl: string; requested: true; settled: false } {
  const { direction, expectedUrl, observationRevision, observationId } = parameters;
  if (!['back', 'forward'].includes(String(direction)) || typeof expectedUrl !== 'string' || !expectedUrl
    || expectedUrl.length > 2048 || !Number.isSafeInteger(observationRevision) || (observationRevision as number) < 0
    || typeof observationId !== 'string' || !/^[0-9a-f-]{36}$/u.test(observationId))
    throw new Error('A history direction and observed URL are required.');
  const guest = context.guest as HistoryGuest | null;
  if (!guest?.getURL || guest.getURL() !== expectedUrl || context.history[context.index] !== expectedUrl
    || context.revision !== observationRevision || context.observationId !== observationId)
    throw new Error('The page changed; take a new snapshot before navigating history.');
  if (historyNavigationPending(context.pending, guest, context.history[context.index]) || context.otherPending())
    throw new Error('A prior browser action may still complete; wait before navigating history.');
  const delta = direction === 'back' ? -1 : 1;
  const target = context.history[context.index + delta];
  if (!target) throw new Error(`No ${direction} page is available in this preview history.`);
  context.pending.current = { fromGuest: guest, target };
  context.move(delta);
  return { direction: direction as string, urlBefore: expectedUrl, targetUrl: target, requested: true, settled: false };
}
