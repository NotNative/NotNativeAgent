// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import type { DirectoryStore } from '../sync/types.ts';
import { useSettingsField } from '../components/settings/page-helpers.tsx';
export type CelebrationPreference = 'pulse' | 'static' | 'off';

/** Invariant: idle is transport state; success requires a structured turn outcome or compatibility message finish. */
export function CompletionAffordance({ store, sessionID }: { store: StoreApi<DirectoryStore>; sessionID: string | null }): ReactNode {
  const snapshot = useSyncExternalStore(store.subscribe, store.getState);
  const preference = useSettingsField<CelebrationPreference>('celebrationPreference').value ?? 'off';
  const [pulsing, setPulsing] = useState(false);
  const [reduced, setReduced] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const observed = useRef<{ store: StoreApi<DirectoryStore>; sessionID: string | null; active: boolean; baseline: string | null }>({ store, sessionID, active: false, baseline: null });
  const status = sessionID ? snapshot.session_status[sessionID] : undefined;
  const messages = sessionID ? snapshot.message[sessionID] ?? [] : [];
  const completed = messages.findLast(message => message.role === 'assistant' && message.time.completed !== undefined);
  const turn = snapshot.activity.findLast(row => row.sessionID === sessionID && row.kind === 'turn' && row.status !== 'started');
  const completionID = turn?.turnOutcome !== undefined ? turn.id : completed?.id ?? null;
  const successful = turn?.turnOutcome !== undefined ? turn.turnOutcome === 'completed'
    : completed?.role === 'assistant' && completed.finish === 'stop' && !completed.error;
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    setReduced(query?.matches ?? false);
    const changed = (): void => setReduced(query?.matches ?? false);
    query?.addEventListener('change', changed);
    return () => query?.removeEventListener('change', changed);
  }, []);
  useEffect(() => {
    let current = observed.current;
    if (current.store !== store || current.sessionID !== sessionID) {
      current = { store, sessionID, active: false, baseline: completionID }; observed.current = current;
      setPulsing(false); if (timer.current) clearTimeout(timer.current);
    }
    if (status?.type === 'busy' || status?.type === 'retry') {
      if (!current.active) { current.active = true; current.baseline = completionID; setPulsing(false); }
      return;
    }
    if (status?.type !== 'idle' || !current.active || !completionID || completionID === current.baseline) return;
    current.active = false;
    if (!successful || preference === 'off') return;
    setPulsing(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setPulsing(false), 4000);
  }, [store, sessionID, status, completionID, successful, preference]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  if (!pulsing || preference === 'off') return null;
  return <div role="status" data-testid="completion-affordance" className={`mx-auto w-fit rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300 ${preference === 'pulse' && !reduced ? 'completion-pulse' : ''}`}>Turn completed</div>;
}
