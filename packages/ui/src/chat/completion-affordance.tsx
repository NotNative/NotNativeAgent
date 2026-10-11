// SPDX-License-Identifier: Apache-2.0
/**
 * Completion celebration affordance (W-96, doc 05 §I#celebration): when a
 * session's status settles from busy/retry to idle, render a brief
 * "Session completed" pulse. Honors, in order: the celebrationPreference
 * setting ('off' renders nothing, 'static' renders without the animation
 * class, 'pulse' animates) and the OS prefers-reduced-motion media query
 * (which always forces the static rendering). The pulse self-clears after
 * four seconds and never re-fires without a new busy→idle transition.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import type { DirectoryStore } from '../sync/types.ts';
import type { SessionStatus } from '../lib/nnd/types.ts';
import { useSettingsField } from '../components/settings/page-helpers.tsx';

export type CelebrationPreference = 'pulse' | 'static' | 'off';

const PULSE_MS = 4000;

function settled(status: SessionStatus | undefined): boolean {
  return status?.type === 'idle';
}

function active(status: SessionStatus | undefined): boolean {
  return status?.type === 'busy' || status?.type === 'retry';
}

export function CompletionAffordance({ store, sessionID }: { store: StoreApi<DirectoryStore>; sessionID: string | null }): ReactNode {
  const snapshot = useSyncExternalStore(store.subscribe, store.getState);
  const preferenceBinding = useSettingsField<CelebrationPreference>('celebrationPreference');
  const preference: CelebrationPreference = preferenceBinding.value ?? 'pulse';
  const [pulsing, setPulsing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasActive = useRef(false);

  const status = sessionID ? snapshot.session_status[sessionID] : undefined;
  useEffect(() => {
    if (!sessionID) { wasActive.current = false; return; }
    if (active(status)) { wasActive.current = true; return; }
    if (!settled(status) || !wasActive.current) return;
    wasActive.current = false;
    if (preference === 'off') return;
    setPulsing(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setPulsing(false), PULSE_MS);
  }, [status, sessionID, preference]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  if (!pulsing || preference === 'off') return null;
  // Read reduced motion at render time (no media listener registration — the
  // shared matchMedia mock contract in tests must keep its single listener).
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
  const animated = preference === 'pulse' && !reducedMotion;
  return (
    <div
      role="status"
      data-testid="completion-affordance"
      className={`mx-auto w-fit rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300 ${animated ? 'completion-pulse' : ''}`}
    >
      Session completed
    </div>
  );
}
