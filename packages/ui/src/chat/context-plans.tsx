// SPDX-License-Identifier: Apache-2.0
/** Transitional personal plan editor over the NND project-context API. */
import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type ReactNode, type SetStateAction } from 'react';
import { createProjectPlan, deleteProjectPlan, getProjectContext, getProjectPlan,
  shareProjectPlan, unshareProjectPlan, updateProjectPlan, type ProjectContext, type ProjectPlan } from '../lib/project-context-api.ts';

export interface ContextPlanDraft { title: string; body: string; selectedId: string | null; raw: string; savedRaw?: string }

function usablePlan(value: unknown): value is ProjectPlan {
  return !!value && typeof value === 'object' && typeof (value as ProjectPlan).id === 'string'
    && typeof (value as ProjectPlan).file === 'string' && typeof (value as ProjectPlan).title === 'string';
}

function closePlanDraft(draft: ContextPlanDraft, setDraft: Dispatch<SetStateAction<ContextPlanDraft>>): void {
  if (draft.raw !== draft.savedRaw && !window.confirm('Discard unsaved changes to the open plan?')) return;
  setDraft((current) => ({ ...current, selectedId: null, raw: '', savedRaw: undefined }));
}

function useSavedPlanList(projectId: string, directory: string, visible: boolean): {
  context: ProjectContext | null; setContext: Dispatch<SetStateAction<ProjectContext | null>>;
  error: string; setError: Dispatch<SetStateAction<string>>; loading: boolean;
  refresh: () => void; sequence: MutableRefObject<number>;
} {
  const [context, setContext] = useState<ProjectContext | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const sequence = useRef(0);
  useEffect(() => {
    if (!visible) return;
    let active = true;
    const token = ++sequence.current;
    setLoading(true);
    void getProjectContext(projectId, directory).then((value) => {
      if (active && token === sequence.current) { setContext(value); setLoading(false); setError(''); }
    }).catch(() => { if (active && token === sequence.current) {
      setLoading(false); setError('Saved plans could not be loaded. Existing drafts were left untouched.');
    } });
    return () => { active = false; };
  }, [projectId, directory, revision, visible]);
  return { context, setContext, error, setError, loading,
    refresh: () => setRevision((value) => value + 1), sequence };
}

interface PlanActionScope {
  projectId: string; directory: string; busy: boolean; draft: ContextPlanDraft;
  setContext: Dispatch<SetStateAction<ProjectContext | null>>;
  setDraft: Dispatch<SetStateAction<ContextPlanDraft>>;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string>>;
  sequence: MutableRefObject<number>;
  live: MutableRefObject<boolean>;
}

async function openSavedPlan(scope: PlanActionScope, planId: string): Promise<void> {
  if (scope.busy || scope.draft.selectedId === planId) return;
  if (scope.draft.selectedId && scope.draft.raw !== scope.draft.savedRaw
    && !window.confirm('Discard unsaved changes to the open plan?')) return;
  scope.setBusy(true); scope.setError('');
  try {
    const plan = await getProjectPlan(scope.projectId, planId, scope.directory);
    const raw = plan.raw ?? '';
    if (scope.live.current) scope.setDraft((current) => ({ ...current, selectedId: plan.id, raw, savedRaw: raw }));
  } catch { if (scope.live.current) scope.setError('Plan could not be opened.'); }
  finally { if (scope.live.current) scope.setBusy(false); }
}

async function createSavedPlan(scope: PlanActionScope): Promise<void> {
  if (scope.busy || !scope.draft.title.trim()) return;
  ++scope.sequence.current;
  scope.setBusy(true); scope.setError('');
  try {
    const committed = await createProjectPlan(scope.projectId, { title: scope.draft.title, body: scope.draft.body });
    if (scope.live.current) { scope.setContext(committed.context); scope.setDraft({ title: '', body: '', selectedId: null, raw: '' }); }
  } catch { if (scope.live.current) scope.setError('Plan could not be created. Your draft is still here.'); }
  finally { if (scope.live.current) scope.setBusy(false); }
}

async function saveSavedPlan(scope: PlanActionScope): Promise<void> {
  if (scope.busy || !scope.draft.selectedId) return;
  ++scope.sequence.current;
  scope.setBusy(true); scope.setError('');
  try {
    const committed = await updateProjectPlan(scope.projectId, scope.draft.selectedId, scope.draft.raw, scope.directory);
    if (scope.live.current) {
      scope.setDraft((current) => ({ ...current, raw: committed.raw, savedRaw: committed.raw }));
      scope.setContext((current) => current && ({ ...current, plans: current.plans.map((item) =>
        usablePlan(item) && item.id === committed.plan.id ? committed.plan : item) }));
    }
  } catch { if (scope.live.current) scope.setError('Plan save failed. Your markdown draft is still here.'); }
  finally { if (scope.live.current) scope.setBusy(false); }
}

async function shareSavedPlan(scope: PlanActionScope, action: 'share' | 'unshare'): Promise<{
  plan: ProjectPlan; context: ProjectContext; sharedPlansDir: string;
}> {
  if (scope.busy || !scope.draft.selectedId) throw new Error('No open plan');
  ++scope.sequence.current;
  scope.setBusy(true); scope.setError('');
  try {
    const committed = action === 'share'
      ? await shareProjectPlan(scope.projectId, scope.draft.selectedId, scope.directory)
      : await unshareProjectPlan(scope.projectId, scope.draft.selectedId, scope.directory);
    if (scope.live.current) scope.setContext(committed.context);
    return committed;
  } catch (error) {
    if (scope.live.current) scope.setError(error instanceof Error ? error.message : 'Plan transfer failed.');
    throw error;
  } finally { if (scope.live.current) scope.setBusy(false); }
}

export function ContextPlans({ projectId, directory, visible, query = '', retainedDraft, onDraftChange }: {
  projectId: string; directory: string; visible: boolean; query?: string; retainedDraft?: ContextPlanDraft;
  onDraftChange?: (projectId: string, draft: ContextPlanDraft) => void;
}): ReactNode {
  return <ContextPlansForProject key={projectId} projectId={projectId} directory={directory} visible={visible} query={query}
    retainedDraft={retainedDraft} onDraftChange={onDraftChange} />;
}

function ContextPlansForProject({ projectId, directory, visible, query, retainedDraft, onDraftChange }: {
  projectId: string; directory: string; visible: boolean; query: string; retainedDraft?: ContextPlanDraft;
  onDraftChange?: (projectId: string, draft: ContextPlanDraft) => void;
}): ReactNode {
  const { context, setContext, error, setError, loading, refresh, sequence } = useSavedPlanList(projectId, directory, visible);
  const [draft, setDraft] = useState<ContextPlanDraft>(() => retainedDraft ?? { title: '', body: '', selectedId: null, raw: '' });
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => { onDraftChange?.(projectId, draft); }, [draft, onDraftChange, projectId]);
  const scope: PlanActionScope = { projectId, directory, busy, draft, setContext, setDraft, setBusy,
    setError, sequence, live };
  async function remove(): Promise<void> {
    if (busy || !draft.selectedId || !window.confirm('Delete this saved plan permanently?')) return;
    ++sequence.current;
    setBusy(true); setError('');
    try {
      const committed = await deleteProjectPlan(projectId, draft.selectedId, directory);
      if (live.current) { setContext(committed); setDraft((current) => ({ ...current, selectedId: null, raw: '', savedRaw: undefined })); }
    } catch { if (live.current) setError('Plan could not be deleted.'); }
    finally { if (live.current) setBusy(false); }
  }
  return <SavedPlanPanel context={context} error={error} loading={loading} busy={busy} refresh={refresh} query={query}
    draft={draft} setDraft={setDraft} open={(planId) => openSavedPlan(scope, planId)}
    create={() => createSavedPlan(scope)} save={() => saveSavedPlan(scope)} remove={remove}
    share={(action) => shareSavedPlan(scope, action)}
    close={() => closePlanDraft(draft, setDraft)} />;
}

function SavedPlanPanel({ context, error, loading, busy, refresh, query, draft, setDraft, open, create, save, remove, share, close }: {
  context: ProjectContext | null; error: string; loading: boolean; busy: boolean; refresh: () => void; query: string;
  draft: ContextPlanDraft; setDraft: Dispatch<SetStateAction<ContextPlanDraft>>;
  open: (id: string) => Promise<void>; create: () => Promise<void>; save: () => Promise<void>;
  remove: () => Promise<void>;
  share: (action: 'share' | 'unshare') => Promise<{ plan: ProjectPlan; context: ProjectContext; sharedPlansDir: string }>;
  close: () => void;
}): ReactNode {
  return <section className="flex h-full min-h-0 flex-col gap-2 p-3" data-testid="project-context-plans">
    <SavedPlanHeader busy={busy} refresh={refresh} />
    {error ? <p role="alert" className="text-xs text-amber-300">{error}</p> : null}
    {!context && loading ? <p className="text-xs text-neutral-500">Loading saved plans…</p> : null}
    {context ? <>
      <SavedPlanList plans={context.plans} query={query} busy={busy} open={open} />
      <PlanDraftEditor draft={draft} setDraft={setDraft} busy={busy} create={create} save={save} remove={remove}
        shared={isSharedPlan(context, draft.selectedId)} share={share} close={close} />
    </> : null}
  </section>;
}

function SavedPlanHeader({ busy, refresh }: { busy: boolean; refresh: () => void }): ReactNode {
  return <header className="flex items-center text-[10px] text-neutral-400">NND saved plans
    <button type="button" disabled={busy} className="ml-auto underline" onClick={refresh}>Refresh</button>
  </header>;
}

function SavedPlanList({ plans, query, busy, open }: { plans: ProjectContext['plans']; query: string; busy: boolean;
  open: (id: string) => Promise<void> }): ReactNode {
  const needle = query.trim().toLocaleLowerCase();
  const visiblePlans = plans.filter(usablePlan).filter((plan) => !needle || plan.title.toLocaleLowerCase().includes(needle));
  return <>
    {plans.some((item) => !usablePlan(item)) ? <p role="status" className="text-xs text-amber-300">Some stored plans could not be displayed.</p> : null}
    {needle && !visiblePlans.length ? <p className="text-xs text-neutral-500">No matching plan titles.</p> : null}
    <ol className="max-h-32 overflow-y-auto">{visiblePlans.map((plan) => <li key={plan.id}>
      <button type="button" disabled={busy} className="py-1 text-left text-xs text-sky-300" onClick={() => { void open(plan.id); }}>
        {plan.title}
        <span className="ml-1 text-[10px] text-neutral-400">{plan.source === 'shared' || plan.shared ? 'shared' : 'personal'}</span>
      </button>
    </li>)}</ol>
  </>;
}

function PlanDraftEditor({ draft, setDraft, busy, create, save, remove, shared, share, close }: {
  draft: ContextPlanDraft; setDraft: Dispatch<SetStateAction<ContextPlanDraft>>; busy: boolean;
  create: () => Promise<void>; save: () => Promise<void>; remove: () => Promise<void>;
  shared: boolean;
  share: (action: 'share' | 'unshare') => Promise<{ plan: ProjectPlan; context: ProjectContext; sharedPlansDir: string }>;
  close: () => void;
}): ReactNode {
  return draft.selectedId ? <div className="flex min-h-0 flex-1 flex-col gap-1">
    <label className="text-xs">Plan markdown<textarea aria-label="Saved plan markdown" value={draft.raw}
      onChange={(event) => setDraft((current) => ({ ...current, raw: event.target.value }))}
      disabled={busy} className="mt-1 min-h-24 w-full flex-1 resize-y rounded border border-white/10 bg-neutral-900/40 p-2 text-xs" /></label>
    <div className="flex gap-2 text-xs"><button type="button" disabled={busy} onClick={() => { void save(); }}>Save plan</button>
      <button type="button" disabled={busy} onClick={() => { void remove(); }}>Delete plan</button>
      <button type="button" disabled={busy} className="ml-2" onClick={() => { void share(shared ? 'unshare' : 'share'); }}>
        {shared ? 'Unshare plan' : 'Share plan'}
      </button>
      <button type="button" disabled={busy} onClick={close}>Close</button></div>
  </div> : <div className="flex flex-col gap-1">
    <input aria-label="New plan title" value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
      disabled={busy} maxLength={200} className="rounded border border-white/10 bg-neutral-900/40 p-2 text-xs" />
    <textarea aria-label="New plan body" value={draft.body} onChange={(event) => setDraft((current) => ({ ...current, body: event.target.value }))}
      disabled={busy} className="min-h-24 resize-y rounded border border-white/10 bg-neutral-900/40 p-2 text-xs" />
    <button type="button" disabled={busy || !draft.title.trim()} className="self-end text-xs" onClick={() => { void create(); }}>Create plan</button>
  </div>;
}

function isSharedPlan(context: ProjectContext | null, planId: string | null): boolean {
  if (planId?.startsWith('shared:')) return true;
  const plan = context?.plans.filter((item): item is ProjectPlan => usablePlan(item)).find((item) => item.id === planId);
  return plan?.shared === true;
}
