// SPDX-License-Identifier: Apache-2.0
/** Docked operator surfaces. Activity consumes explicit harness evidence only. */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import type { DirectoryStore } from '../sync/types.ts';
import type { SyncEngine } from '../sync/sync-engine.ts';
import { useSessionViewStore } from '../sync/view-store.ts';
import { useGlobalSyncStore } from '../sync/global-stores.ts';
import { WorkStatusPanel } from './work-status-panel.tsx';
import { GitView } from '../components/git/GitView.tsx';
import { DiffView } from '../components/diff/DiffView.tsx';
import { WorktreesView } from '../components/worktrees/WorktreesView.tsx';
import { OperatorFiles } from './operator-files.tsx';
import { ActivitySurface } from './operator-activity-surface.tsx';
import { commitDraftScope } from '../lib/git/commit-drafts.ts';
import { ProjectNotes, type NotesDraftLease } from './project-notes.tsx';
import { addTodoToCurrentChat, stageTodoInNewChat } from './todo-chat-handoff.ts';
import type { ContextPlanDraft } from './context-plans.tsx';
import type { ContextNotesDraft } from './context-notes.tsx';
import { TerminalView } from '../components/terminal/TerminalView.tsx';
import { BrowserSurface } from './browser-surface.tsx';
import { WalkthroughPreviewSurface } from './walkthrough-preview.tsx';
import { getRuntimeKey, isTransientRuntimeKey } from '../lib/runtime-switch.ts';
import { OperatorIcon } from './operator-icons.tsx';
import { resolveContextProjectId } from './operator-context-project.ts';
import { panelOpenStorageKey, readPanelOpen } from './operator-panel-open.ts';
import { maxRailWidth } from './operator-rail-width.ts';
import { useOperatorRailWidth } from './use-operator-rail-width.ts';
import { persistLastActiveSession } from '../sync/persist-cache.ts';
import { useContextRoute } from '../components/use-context-route.ts';
export { resolveContextProjectId } from './operator-context-project.ts';

type Surface = 'context' | 'activity' | 'changes' | 'files' | 'worktrees' | 'walkthrough' | 'notes' | 'browser' | 'terminal';
const SURFACES: readonly { id: Surface; label: string }[] = [
  { id: 'context', label: 'Context' },
  { id: 'activity', label: 'Activity' },
  { id: 'changes', label: 'Changes' },
  { id: 'files', label: 'Files' },
  { id: 'worktrees', label: 'Worktrees' },
  { id: 'walkthrough', label: 'Walkthrough' },
  { id: 'notes', label: 'Notes' },
  { id: 'browser', label: 'Browser' },
  { id: 'terminal', label: 'Terminal' },
];
type PanelPreferences = { order: Surface[]; visible: Surface[] };
type ReviewRequest = { directory: string; path: string; id: number; runtimeKey: string };
const DEFAULT_PANEL_PREFERENCES: PanelPreferences = {
  order: SURFACES.map((item) => item.id), visible: SURFACES.map((item) => item.id),
};

export function OperatorRail({ store, engine, directory, displayedSessionID, compactOpen = false, suppressed = false, onCloseCompact }: {
  store: StoreApi<DirectoryStore>; engine: SyncEngine; directory: string; displayedSessionID?: string | null;
  compactOpen?: boolean; suppressed?: boolean; onCloseCompact?: () => void;
}): ReactNode {
  // Keep the rail paired with the displayed chat during a cold switch.
  const walkthroughSessionId = useSessionViewStore((state) => displayedSessionID !== undefined
    ? displayedSessionID : state.activeDirectory === directory ? state.currentSessionId : null);
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && (window.matchMedia?.('(min-width: 1280px)').matches ?? false));
  const [docked, setDocked] = useState(() => typeof window !== 'undefined' && (window.matchMedia?.('(min-width: 1100px)').matches ?? false));
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const query = window.matchMedia?.('(min-width: 1280px)');
    if (!query) return;
    setWide(query.matches);
    const update = (event: MediaQueryListEvent): void => setWide(event.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const query = window.matchMedia?.('(min-width: 1100px)');
    if (!query) return;
    setDocked(query.matches);
    const update = (event: MediaQueryListEvent): void => setDocked(event.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!docked || compactOpen || suppressed) setMaximized(false);
  }, [compactOpen, docked, suppressed]);
  const global = useSyncExternalStore(useGlobalSyncStore.subscribe, useGlobalSyncStore.getState);
  const projectId = resolveContextProjectId(directory, global.projects);
  const storageKey = surfaceStorageKey(directory);
  const changesIdentity = `${getRuntimeKey()}:${storageKey}`;
  const openKey = panelOpenStorageKey(storageKey);
  const openIdentity = openKey ?? `volatile:${getRuntimeKey()}:${storageKey}`;
  const [openState, setOpenState] = useState(() => ({ key: openIdentity, value: readPanelOpen(openKey, wide), touched: false }));
  const panelOpen = openState.key === openIdentity ? openState.value : readPanelOpen(openKey, wide);
  const setPanelOpen = (next: boolean | ((current: boolean) => boolean)): void => {
    setOpenState({ key: openIdentity, value: typeof next === 'function' ? next(panelOpen) : next, touched: true });
  };
  useEffect(() => {
    if (openState.key !== openIdentity) setOpenState({ key: openIdentity, value: readPanelOpen(openKey, wide), touched: false });
  }, [openIdentity, openKey, openState.key, wide]);
  useEffect(() => {
    // A viewport-derived default is not an operator preference. Persist only
    // after an explicit panel action or compact-to-docked handoff.
    if (openState.key !== openIdentity || openKey === null || !openState.touched) return;
    try { localStorage.setItem(openKey, openState.value ? 'open' : 'closed'); } catch { /* optional device preference */ }
  }, [openIdentity, openKey, openState.key, openState.touched, openState.value]);
  useEffect(() => {
    // When a foreground compact surface becomes docked, keep its pane open.
    // ChatView simultaneously restores the chat column at this breakpoint.
    if (docked && compactOpen) setPanelOpen(true);
  }, [compactOpen, docked]);
  const paneVisible = !suppressed && (compactOpen || (docked && panelOpen));
  const selectionKey = surfaceSelectionKey(storageKey);
  const preferencesKey = panelPreferencesKey(storageKey);
  const [panelState, setPanelState] = useState(() => ({ key: preferencesKey, value: readPanelPreferences(preferencesKey) }));
  const panels = panelState.key === preferencesKey ? panelState.value : readPanelPreferences(preferencesKey);
  const [customizing, setCustomizing] = useState(false);
  const [reviewRequest, setReviewRequest] = useState<ReviewRequest | null>(null);
  const [diffRoute, setDiffRoute] = useState<{ identity: string; path: string | null; revision: number } | null>(null);
  const [changesMode, setChangesMode] = useState<'git' | 'diff'>('git');
  const retainedDiff = diffRoute?.identity === changesIdentity;
  const routedDiff = retainedDiff && changesMode === 'diff';
  const reviewIdentity = useRef(changesIdentity);
  useEffect(() => {
    // A jump belongs to the workspace/runtime where Activity authored it.
    // Do not replay it when a retained Changes view is mounted again later.
    if (reviewIdentity.current !== changesIdentity) {
      reviewIdentity.current = changesIdentity;
      setReviewRequest(null);
    }
  }, [changesIdentity]);
  useEffect(() => {
    if (panelState.key !== preferencesKey) setPanelState({ key: preferencesKey, value: readPanelPreferences(preferencesKey) });
  }, [panelState.key, preferencesKey]);
  useEffect(() => {
    if (panelState.key !== preferencesKey || preferencesKey === null) return;
    try { localStorage.setItem(preferencesKey, JSON.stringify(panelState.value)); } catch { /* optional device preference */ }
  }, [panelState.key, panelState.value, preferencesKey]);
  const changePanels = (next: PanelPreferences): void => setPanelState({ key: preferencesKey, value: next });
  const [selection, setSelection] = useState(() => ({ key: selectionKey, surface: readSurface(selectionKey) }));
  // A single chat view can move between directories without remounting.  Do
  // not write its old selection into the newly selected directory before its
  // stored selection has been read.
  const selectedSurface = selection.key === selectionKey ? selection.surface : readSurface(selectionKey);
  const surface = panels.visible.includes(selectedSurface) ? selectedSurface : panels.order.find((id) => panels.visible.includes(id))!;
  const { width, viewportWidth, resize, fit } = useOperatorRailWidth(storageKey, surface);
  const dragCleanup = useRef<(() => void) | null>(null);
  const selectedButton = useRef<HTMLButtonElement | null>(null);
  useEffect(() => () => dragCleanup.current?.(), []);
  useEffect(() => {
    if (selection.key !== selectionKey) setSelection({ key: selectionKey, surface: readSurface(selectionKey) });
  }, [selection.key, selectionKey]);
  useEffect(() => {
    if (selection.key === selectionKey && selection.surface !== surface) setSelection({ key: selectionKey, surface });
  }, [selection.key, selection.surface, selectionKey, surface]);
  useEffect(() => {
    if (selection.key !== selectionKey) return;
    try { localStorage.setItem(selectionKey, selection.surface); } catch { /* optional device preference */ }
  }, [selection.key, selection.surface, selectionKey]);
  // Apply links after restoring project preferences so those effects cannot
  // overwrite a newly routed pane during a retained rail's project switch.
  useContextRoute(directory, walkthroughSessionId, (request) => {
    if (request.tab === 'chat') { setPanelOpen(false); return; }
    const requested: Surface = request.tab === 'git' || request.tab === 'diff' ? 'changes' : request.tab;
    if (!panels.visible.includes(requested)) changePanels({ ...panels, visible: [...panels.visible, requested] });
    setSelection({ key: selectionKey, surface: requested });
    setPanelOpen(true);
    if (request.tab === 'diff') setDiffRoute({ identity: changesIdentity, path: request.file, revision: request.revision });
    if (request.tab === 'diff' || request.tab === 'git') setChangesMode(request.tab);
    setReviewRequest(null);
  });
  // A tool-driven browser open reveals the Browser pane so the preview guest
  // exists for the governed bridge actions (F7).
  useEffect(() => {
    const request = () => {
      if (selection.key !== selectionKey) return;
      if (!panels.visible.includes('browser')) changePanels({ ...panels, visible: [...panels.visible, 'browser'] });
      setBrowserOpenedKey(storageKey);
      setPanelOpen(true);
      setSelection({ key: selectionKey, surface: 'browser' });
    };
    window.addEventListener('nnd-browser-pane-request', request);
    return () => window.removeEventListener('nnd-browser-pane-request', request);
  }, [selection.key, selectionKey, panels, changePanels, storageKey]); // panelOpen setter is stable
  // Keep opened views mounted across rail surfaces. A project switch remounts
  // Notes, while the single dirty-draft lease above survives that remount.
  const [terminalOpenedKey, setTerminalOpenedKey] = useState<string | null>(() => selection.surface === 'terminal' ? storageKey : null);
  const [browserOpenedKey, setBrowserOpenedKey] = useState<string | null>(() => selection.surface === 'browser' ? storageKey : null);
  const [notesOpenedKey, setNotesOpenedKey] = useState<string | null>(() => selection.surface === 'notes' ? storageKey : null);
  const [changesOpenedKey, setChangesOpenedKey] = useState<string | null>(() => selection.surface === 'changes' ? changesIdentity : null);
  const [filesOpenedKey, setFilesOpenedKey] = useState<string | null>(() => selection.surface === 'files' ? changesIdentity : null);
  const [worktreesOpenedKey, setWorktreesOpenedKey] = useState<string | null>(() => selection.surface === 'worktrees' ? changesIdentity : null);
  // Exactly one unsaved General Notes draft may cross project mounts. The
  // Notes pane locks other projects until this lease is saved or discarded.
  const [notesDraft, setNotesDraft] = useState<NotesDraftLease | null>(null);
  const [contextDrafts, setContextDrafts] = useState<Record<string, ContextNotesDraft>>({});
  const retainContextDraft = useCallback((id: string, draft: ContextNotesDraft): void => {
    setContextDrafts((current) => ({ ...current, [id]: draft }));
  }, []);
  const [planDrafts, setPlanDrafts] = useState<Record<string, ContextPlanDraft>>({});
  const retainPlanDraft = useCallback((id: string, draft: ContextPlanDraft): void => {
    setPlanDrafts((current) => ({ ...current, [id]: draft }));
  }, []);
  const [todoDrafts, setTodoDrafts] = useState<Record<string, string>>({});
  const retainTodoDraft = useCallback((id: string, draft: string): void => {
    setTodoDrafts((current) => ({ ...current, [id]: draft }));
  }, []);
  useEffect(() => {
    if (selection.key === selectionKey && surface === 'terminal') setTerminalOpenedKey(storageKey);
  }, [selection.key, selectionKey, storageKey, surface]);
  useEffect(() => {
    if (selection.key === selectionKey && surface === 'browser') setBrowserOpenedKey(storageKey);
  }, [selection.key, selectionKey, storageKey, surface]);
  useEffect(() => {
    if (selection.key === selectionKey && surface === 'notes') setNotesOpenedKey(storageKey);
  }, [selection.key, selectionKey, storageKey, surface]);
  useEffect(() => {
    if (selection.key === selectionKey && surface === 'changes') setChangesOpenedKey(changesIdentity);
  }, [changesIdentity, selection.key, selectionKey, surface]);
  useEffect(() => { if (selection.key === selectionKey && surface === 'files') setFilesOpenedKey(changesIdentity); }, [changesIdentity, selection.key, selectionKey, surface]);
  useEffect(() => {
    if (selection.key === selectionKey && surface === 'worktrees') setWorktreesOpenedKey(changesIdentity);
  }, [changesIdentity, selection.key, selectionKey, surface]);
  // The 40px icon nav sits inside this aside's 1px border. Omitting that
  // border pixel makes the document itself scroll in both directions.
  const dockWidth = 41;
  return (
    <aside className={`${suppressed ? 'hidden' : compactOpen || docked ? 'flex' : 'hidden'} ${maximized && docked && !compactOpen ? 'absolute inset-0 z-30 w-full' : `relative shrink-0 ${surface === 'browser' ? 'w-full xl:w-[min(60vw,900px)]' : 'w-full xl:w-[300px]'}`} min-w-0 flex-col border-l border-white/10 bg-neutral-950`} style={docked && !compactOpen && !maximized ? { width: panelOpen ? width + dockWidth : dockWidth } : undefined} data-testid="operator-rail">
      <div role="separator" aria-label="Resize operator panel" aria-orientation="vertical" aria-valuemin={280} aria-valuemax={maxRailWidth(viewportWidth)} aria-valuenow={width} tabIndex={0}
        className={`absolute bottom-0 left-0 top-0 z-20 w-1 cursor-col-resize hover:bg-white/20 focus:bg-white/20 ${compactOpen || suppressed || !panelOpen || maximized ? 'hidden' : 'hidden min-[1100px]:block'}`}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          dragCleanup.current?.();
          const startX = event.clientX;
          const startWidth = width;
          const move = (next: PointerEvent): void => resize(startWidth + startX - next.clientX);
          const stop = (): void => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', stop);
            window.removeEventListener('pointercancel', stop);
            dragCleanup.current = null;
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', stop);
          window.addEventListener('pointercancel', stop);
          dragCleanup.current = stop;
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') { event.preventDefault(); resize(width + 24); }
          else if (event.key === 'ArrowRight') { event.preventDefault(); resize(width - 24); }
          else if (event.key === 'Home') { event.preventDefault(); resize(280); }
          else if (event.key === 'End') { event.preventDefault(); resize(maxRailWidth(viewportWidth)); }
        }} />
      {compactOpen ? <div className="border-b border-white/10 px-3 py-2">
        <button type="button" data-testid="operator-return-chat" className="rounded px-2 py-1 text-xs text-neutral-200 hover:bg-white/10" onClick={onCloseCompact}>← Return to chat</button>
      </div> : null}
      <div className={`${docked && !panelOpen && !compactOpen ? 'hidden' : 'flex'} items-center justify-between border-b border-white/10 px-3 py-1.5 text-[11px] text-neutral-300`} data-testid="operator-surface-title">
        {SURFACES.find((item) => item.id === surface)?.label}
        {docked && !compactOpen ? <div className="flex items-center gap-2">
          {!maximized ? <button type="button" aria-label="Fit operator panel to window" title="Fit panel to window"
            className="rounded px-1 text-neutral-500 hover:text-neutral-200"
            onClick={fit}>↔</button> : null}
          <button type="button" aria-label={maximized ? 'Restore operator panel' : 'Maximize operator panel'} aria-pressed={maximized}
            className="rounded px-1 text-neutral-500 hover:text-neutral-200" onClick={() => setMaximized((value) => !value)}>{maximized ? '↙' : '⛶'}</button>
          <button type="button" aria-label="Close operator panel" className="rounded px-1 text-neutral-500 hover:text-neutral-200" onClick={() => { setMaximized(false); setPanelOpen(false); selectedButton.current?.focus(); }}>×</button>
        </div> : null}
      </div>
      <div className="flex min-h-0 flex-1">
      <nav className="order-2 flex w-10 shrink-0 flex-col border-l border-white/10 py-2" aria-label="Operator surfaces">
        {panels.order.filter((id) => panels.visible.includes(id)).map((id) => {
          const item = SURFACES.find((candidate) => candidate.id === id)!;
          return (
          <button key={item.id} ref={surface === item.id ? selectedButton : undefined} type="button" title={item.label} aria-label={item.label} aria-pressed={surface === item.id}
            className={`flex h-10 items-center justify-center ${surface === item.id && paneVisible ? 'text-amber-500' : 'text-neutral-500 hover:text-neutral-200'}`}
            onClick={() => {
              if (item.id === 'terminal') setTerminalOpenedKey(storageKey);
              if (item.id === 'browser') setBrowserOpenedKey(storageKey);
              if (item.id === 'notes') setNotesOpenedKey(storageKey);
              if (item.id === 'changes') setChangesOpenedKey(changesIdentity);
              if (item.id === 'files') setFilesOpenedKey(changesIdentity);
              if (item.id === 'worktrees') setWorktreesOpenedKey(changesIdentity);
              // A maximized surface must not collapse into an opaque, full-chat
              // icon strip when its already selected icon is clicked.
              if (docked && !compactOpen) setPanelOpen(maximized || item.id !== surface || !panelOpen);
              setSelection({ key: selectionKey, surface: item.id });
            }}><OperatorIcon surface={item.id} /></button>
          );
        })}
        <button type="button" aria-label="Customize operator panels" aria-expanded={customizing}
          className="mt-auto px-1 py-2 text-[9px] text-neutral-500 hover:text-neutral-200"
          onClick={() => { setPanelOpen(true); setCustomizing((value) => !value); }}>⋯</button>
      </nav>
      <div className={`${docked && !panelOpen && !compactOpen ? 'hidden' : ''} order-1 min-h-0 min-w-0 flex-1 overflow-y-auto`}>
        {customizing ? <section aria-label="Customize operator panels" className="border-b border-white/10 p-2 text-xs">
          <div className="mb-2 text-neutral-300">Panels</div>
          {panels.order.map((id, index) => {
            const item = SURFACES.find((candidate) => candidate.id === id)!;
            const checked = panels.visible.includes(id);
            return <div key={id} className="flex items-center gap-1 py-1">
              <label className="flex min-w-0 flex-1 items-center gap-1 text-neutral-300">
                <input type="checkbox" aria-label={`Show ${item.label}`} checked={checked}
                  disabled={checked && panels.visible.length === 1}
                  onChange={() => {
                    const visible = checked ? panels.visible.filter((entry) => entry !== id) : [...panels.visible, id];
                    changePanels({ ...panels, visible });
                  }} />{item.label}
              </label>
              <button type="button" aria-label={`Move ${item.label} up`} disabled={index === 0}
                className="px-1 disabled:opacity-30" onClick={() => changePanels({ ...panels, order: movedPanel(panels.order, index, -1) })}>↑</button>
              <button type="button" aria-label={`Move ${item.label} down`} disabled={index === panels.order.length - 1}
                className="px-1 disabled:opacity-30" onClick={() => changePanels({ ...panels, order: movedPanel(panels.order, index, 1) })}>↓</button>
            </div>;
          })}
        </section> : null}
        {surface === 'context' ? <WorkStatusPanel store={store} engine={engine} embedded expanded={maximized} sessionID={walkthroughSessionId} onOpenSubagent={(sessionID) => {
          // The child came from this directory's live session projection.
          // Selecting it opens the read-only transcript; NNA alone grants steer.
          persistLastActiveSession(sessionID, directory);
          useSessionViewStore.setState({ currentSessionId: sessionID, activeDirectory: directory });
          if (compactOpen) onCloseCompact?.();
        }} /> : null}
        {surface === 'activity' ? <ActivitySurface store={store} directory={directory} sessionID={walkthroughSessionId} expanded={maximized && docked && !compactOpen} onOpenSubagent={(sessionID) => {
          persistLastActiveSession(sessionID, directory);
          useSessionViewStore.setState({ currentSessionId: sessionID, activeDirectory: directory });
          if (compactOpen) onCloseCompact?.();
        }} onReviewPath={(path) => {
          setChangesMode('git');
          setReviewRequest({ directory, path, id: Date.now(), runtimeKey: getRuntimeKey() });
          setSelection({ key: selectionKey, surface: 'changes' });
        }} /> : null}
        {changesOpenedKey === changesIdentity || surface === 'changes' ? <div className={surface === 'changes' ? 'h-full min-h-0' : 'hidden'}>
          <div className={routedDiff || surface !== 'changes' ? 'hidden' : 'h-full min-h-0'}><GitView key={changesIdentity} directory={directory} draftScope={commitDraftScope(getRuntimeKey(), directory)} visible={surface === 'changes' && paneVisible && !routedDiff} compact reviewRequest={reviewRequest?.runtimeKey === getRuntimeKey() ? reviewRequest : null}
            activityStore={store} sessionID={walkthroughSessionId}
          onOpenWalkthrough={() => {
            if (!panels.visible.includes('walkthrough')) changePanels({ ...panels, visible: [...panels.visible, 'walkthrough'] });
            setSelection({ key: selectionKey, surface: 'walkthrough' });
          }} /></div>
          {retainedDiff ? <div className={routedDiff ? 'h-full min-h-0' : 'hidden'}><DiffView key={changesIdentity} directory={directory} visible={surface === 'changes' && paneVisible && routedDiff} focusPath={diffRoute.path} focusRevision={diffRoute.revision} /></div> : null}
        </div> : null}
        {filesOpenedKey === changesIdentity || surface === 'files' ? <div className={surface === 'files' ? 'h-full min-h-0' : 'hidden'}><OperatorFiles key={changesIdentity} directory={directory} visible={surface === 'files' && paneVisible} /></div> : null}
        {worktreesOpenedKey === changesIdentity || surface === 'worktrees' ? <div className={surface === 'worktrees' ? 'h-full min-h-0' : 'hidden'}>
          <WorktreesView key={changesIdentity} projectRoot={directory} embedded visible={surface === 'worktrees' && paneVisible} />
        </div> : null}
        {surface === 'walkthrough' ? <WalkthroughPreviewSurface directory={directory} sessionId={walkthroughSessionId} visible={paneVisible} /> : null}
        {notesOpenedKey === storageKey || surface === 'notes' ? (
          <div className={surface === 'notes' ? 'h-full min-h-0' : 'hidden'}>
            <ProjectNotes key={storageKey} directory={directory} directoryKey={storageKey} projectId={projectId} visible={surface === 'notes' && paneVisible}
              contextDraft={projectId ? contextDrafts[projectId] : undefined} onContextDraftChange={retainContextDraft}
              planDraft={projectId ? planDrafts[projectId] : undefined} onPlanDraftChange={retainPlanDraft}
              todoDraft={projectId ? todoDrafts[projectId] : undefined} onTodoDraftChange={retainTodoDraft}
              onAddTodoToChat={(text) => {
                const accepted = addTodoToCurrentChat(directory, walkthroughSessionId ?? 'draft', text);
                if (accepted && compactOpen) onCloseCompact?.();
                return accepted;
              }}
              onAddTodoToNewChat={walkthroughSessionId ? (text) => {
                stageTodoInNewChat(directory, text);
                if (compactOpen) onCloseCompact?.();
              } : undefined}
              draftPinSessionId={walkthroughSessionId}
              draftLease={notesDraft} setDraftLease={setNotesDraft} />
          </div>
        ) : null}
        {terminalOpenedKey === storageKey || surface === 'terminal' ? (
          <div className={surface === 'terminal' ? 'flex h-full min-h-0' : 'hidden'}>
            <TerminalView directory={directory} visible={surface === 'terminal' && paneVisible} compact />
          </div>
        ) : null}
        {browserOpenedKey === storageKey || surface === 'browser' ? (
          <div className={surface === 'browser' ? 'h-full min-h-0' : 'hidden'}>
            <BrowserSurface key={storageKey} visible={surface === 'browser' && paneVisible} />
          </div>
        ) : null}
      </div>
      </div>
    </aside>
  );
}

function readSurface(key: string): Surface {
  try { const value = localStorage.getItem(key); return SURFACES.some((surface) => surface.id === value) ? value as Surface : 'context'; } catch { return 'context'; }
}

function surfaceSelectionKey(directoryKey: string): string {
  const runtime = getRuntimeKey();
  // Preserve the existing local preference while isolating selections for
  // remote runtimes whose panel visibility can differ from the local harness.
  return isTransientRuntimeKey(runtime) || runtime === 'local' ? directoryKey : `${directoryKey}:runtime:${runtime}`;
}

function panelPreferencesKey(directoryKey: string): string | null {
  const runtime = getRuntimeKey();
  return isTransientRuntimeKey(runtime) ? null : `nnd.operator-rail.panels:${runtime}:${directoryKey}`;
}

function readPanelPreferences(key: string | null): PanelPreferences {
  if (key === null) return DEFAULT_PANEL_PREFERENCES;
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return DEFAULT_PANEL_PREFERENCES;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return DEFAULT_PANEL_PREFERENCES;
    const value = parsed as Partial<PanelPreferences>;
    const known = new Set<Surface>(DEFAULT_PANEL_PREFERENCES.order);
    const order = Array.isArray(value.order) ? value.order.filter((id): id is Surface => known.has(id)) : [];
    const uniqueOrder = [...new Set(order), ...DEFAULT_PANEL_PREFERENCES.order.filter((id) => !order.includes(id))];
    const visible = Array.isArray(value.visible) ? value.visible.filter((id): id is Surface => known.has(id)) : [];
    const uniqueVisible = [...new Set(visible)];
    // A complete pre-Worktrees layout could not have hidden the new pane.
    // Keep deliberate hides in layouts that already know about Worktrees.
    const preWorktrees = DEFAULT_PANEL_PREFERENCES.order.filter((id) => id !== 'worktrees' && id !== 'files');
    const preFiles = DEFAULT_PANEL_PREFERENCES.order.filter((id) => id !== 'files');
    if (uniqueVisible.length > 0 && order.length === preWorktrees.length && preWorktrees.every((id) => order.includes(id))) uniqueVisible.push('worktrees', 'files');
    else if (uniqueVisible.length > 0 && order.length === preFiles.length && preFiles.every((id) => order.includes(id)) && !uniqueVisible.includes('files')) uniqueVisible.push('files');
    return { order: uniqueOrder, visible: uniqueVisible.length > 0 ? uniqueVisible : DEFAULT_PANEL_PREFERENCES.visible };
  } catch { return DEFAULT_PANEL_PREFERENCES; }
}

function movedPanel(order: Surface[], index: number, distance: -1 | 1): Surface[] {
  const next = [...order];
  const target = index + distance;
  if (target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

/** Match the harness directory identity: slash spelling and drive-case must
 * not turn one Windows project into two independent rail preferences. */
function surfaceStorageKey(directory: string): string {
  let normalized = directory.trim().replaceAll('\\', '/');
  normalized = normalized.replace(/^([a-z]):/u, (_match, drive: string) => `${drive.toUpperCase()}:`);
  normalized = normalized.length > 1 ? normalized.replace(/\/+$/u, '') : normalized;
  return `nnd.operator-rail.surface:${normalized}`;
}
