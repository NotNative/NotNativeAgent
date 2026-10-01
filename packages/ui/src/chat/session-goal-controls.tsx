// SPDX-License-Identifier: Apache-2.0
/** Session-local goal strip and management panel. Child sessions remain read-only. */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import type { DirectoryStore } from '../sync/types.ts';
import { useCurrentIntlLocale } from '../lib/i18n/intl.ts';
import {
  changeGoalStatus, clearSessionGoal, effectiveObjective, loadSessionGoal,
  saveSessionGoal, type GoalSnapshot,
} from './session-goal-actions.ts';

const DEFAULT_BUDGET = 200_000;

function projectedRevision(store: StoreApi<DirectoryStore>, sessionID: string): number {
  const session = store.getState().session.find((item) => item.id === sessionID);
  const nnd = session?.metadata?.['nnd'];
  const revision = nnd && typeof nnd === 'object' ? (nnd as Record<string, unknown>)['goalRevision'] : undefined;
  return typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

export function SessionGoalControls({ sessionID, store, externalRevision = 0 }: {
  sessionID: string; store: StoreApi<DirectoryStore>; externalRevision?: number;
}): ReactNode {
  const intlLocale = useCurrentIntlLocale();
  const localRevision = useSyncExternalStore(store.subscribe, () => projectedRevision(store, sessionID));
  const goalRevision = Math.max(localRevision, externalRevision);
  const [snapshot, setSnapshot] = useState<GoalSnapshot | null>(null);
  const [objective, setObjective] = useState('');
  const [budgetEnabled, setBudgetEnabled] = useState(false);
  const [budget, setBudget] = useState(DEFAULT_BUDGET);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const editLoad = useRef(0);

  useEffect(() => {
    let current = true;
    setSnapshot(null);
    setNotice('');
    void loadSessionGoal(sessionID).then((loaded) => {
      if (current) setSnapshot(loaded);
    }).catch((error) => { if (current) setNotice(String(error)); });
    return () => { current = false; };
  }, [sessionID, goalRevision]);

  const beginEdit = async (): Promise<void> => {
    if (!snapshot) return;
    const request = ++editLoad.current;
    setNotice('');
    setOpen(true);
    setBudgetEnabled(snapshot.goal?.tokenBudget !== null && snapshot.goal?.tokenBudget !== undefined);
    setBudget(snapshot.goal?.tokenBudget ?? DEFAULT_BUDGET);
    if (!snapshot.goal) { setObjective(''); return; }
    setObjective(snapshot.goal.objective);
    const content = await effectiveObjective(sessionID, snapshot.goal);
    if (request === editLoad.current) setObjective(content);
  };

  const run = async (operation: () => Promise<GoalSnapshot>, close = false): Promise<void> => {
    if (pending) return;
    setPending(true);
    setNotice('');
    try {
      const loaded = await operation();
      setSnapshot(loaded);
      if (close) setOpen(false);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
      try { setSnapshot(await loadSessionGoal(sessionID)); } catch { /* keep prior projection */ }
    } finally { setPending(false); }
  };

  if (!snapshot && !notice) return <div className="mb-2 text-[11px] text-neutral-500" data-testid="session-goal-loading">Loading goal…</div>;
  const goal = snapshot?.goal;
  return <section className="mb-2 rounded-lg border border-sky-400/20 bg-sky-950/20 px-3 py-2 text-xs text-neutral-300" data-testid="session-goal-controls">
    <div className="flex flex-wrap items-center gap-2">
      <span aria-hidden>◎</span>
      <span className="font-medium">{goal ? `Goal · ${goal.status}` : 'Session goal'}</span>
      {goal ? <span className="min-w-0 flex-1 truncate text-neutral-400" title={goal.objective}>{goal.note || goal.objective}</span> : <span className="flex-1 text-neutral-500">No goal for this session</span>}
      {goal ? <span className="text-neutral-500">{goal.tokensUsed.toLocaleString(intlLocale)}{goal.tokenBudget !== null ? ` / ${goal.tokenBudget.toLocaleString(intlLocale)}` : ''} tokens</span> : null}
      {goal?.status === 'active' ? <button type="button" disabled={pending} onClick={() => { void run(() => changeGoalStatus(sessionID, 'pause')); }} className="rounded border border-white/15 px-2 py-1 disabled:opacity-40">Pause</button> : null}
      {goal && ['paused', 'blocked', 'budgetLimited'].includes(goal.status) ? <button type="button" disabled={pending} onClick={() => { void run(() => changeGoalStatus(sessionID, 'resume')); }} className="rounded border border-white/15 px-2 py-1 disabled:opacity-40">Resume</button> : null}
      <button type="button" disabled={pending || !snapshot} aria-expanded={open} onClick={() => { if (open) { editLoad.current++; setOpen(false); } else void beginEdit(); }} className="rounded border border-white/15 px-2 py-1 disabled:opacity-40">{goal ? 'Manage' : 'Set goal'}</button>
    </div>
    {notice ? <p role="alert" className="mt-1 text-amber-300">{notice}</p> : null}
    {open ? <div className="mt-2 space-y-2 border-t border-white/10 pt-2" data-testid="session-goal-editor">
      <label className="block text-neutral-400" htmlFor="session-goal-objective">Objective</label>
      <textarea id="session-goal-objective" rows={4} maxLength={5_000} value={objective} disabled={pending || goal?.status === 'complete'} onChange={(event) => { editLoad.current++; setObjective(event.target.value); }} className="w-full rounded border border-white/15 bg-neutral-900 p-2 text-neutral-100" />
      <div className="text-right text-[10px] text-neutral-500">{objective.length} / 5,000</div>
      <label className="flex items-center gap-2"><input type="checkbox" checked={budgetEnabled} disabled={pending || goal?.status === 'complete'} onChange={(event) => setBudgetEnabled(event.target.checked)} />Token budget</label>
      {budgetEnabled ? <input aria-label="Goal token budget" type="number" min={1} max={100_000_000} step={50_000} value={budget} disabled={pending || goal?.status === 'complete'} onChange={(event) => setBudget(Number(event.target.value))} className="w-36 rounded border border-white/15 bg-neutral-900 px-2 py-1" /> : null}
      {goal ? <div className="space-y-1 text-[11px] text-neutral-400">
        {goal.statusReason ? <p>Reason: {goal.statusReason}</p> : null}
        {goal.note ? <p>Progress: {goal.note}</p> : null}
        {goal.evaluationModelID ? <p>Evaluator: {goal.evaluationProviderID}/{goal.evaluationModelID}</p> : null}
        <p>Auto-continuations used: {goal.turnsUsed} of 20.{goal.status === 'active' ? ' Completion needs an independent audit.' : ''}</p>
      </div> : <p className="text-[11px] text-neutral-500">Goal tracking is available; an armed goal self-continues through the engine loop (up to 20 continuations).</p>}
      <div className="flex flex-wrap gap-2">
        {goal?.status !== 'complete' ? <button type="button" disabled={pending || !objective.trim()} onClick={() => { void run(() => saveSessionGoal(sessionID, objective, budgetEnabled ? budget : null), true); }} className="rounded border border-sky-500/40 px-2 py-1 text-sky-200 disabled:opacity-40">{pending ? 'Saving…' : 'Save goal'}</button> : null}
        {goal && goal.status !== 'complete' ? <button type="button" disabled={pending} onClick={() => { void run(() => changeGoalStatus(sessionID, 'complete'), true); }} className="rounded border border-white/15 px-2 py-1 disabled:opacity-40">Mark complete</button> : null}
        {goal ? <button type="button" disabled={pending} onClick={() => { void run(() => clearSessionGoal(sessionID), true); }} className="rounded border border-red-500/30 px-2 py-1 text-red-300 disabled:opacity-40">Clear goal</button> : null}
        <button type="button" disabled={pending} onClick={() => { editLoad.current++; setOpen(false); }} className="rounded border border-white/15 px-2 py-1 disabled:opacity-40">Close</button>
      </div>
    </div> : null}
  </section>;
}
