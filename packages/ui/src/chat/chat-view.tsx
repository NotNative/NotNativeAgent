// SPDX-License-Identifier: Apache-2.0
/**
 * Chat session view (doc 05 §A.2, P3b): transcript + status chip + composer;
 * deferred session-switch hold (400ms — only while the target is NOT warm,
 * instant when warm); prompt rail; timeline dialog; BTW fork transition;
 * §I hydration/error/empty states; focus mode gates the transcript.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import type { DirectoryStore, SessionListSource } from '../sync/types.ts';
import { useSessionViewStore } from '../sync/view-store.ts';
import type { SyncEngine } from '../sync/sync-engine.ts';
import { useMemo } from 'react';
import { Composer, type ComposerServices } from './composer.tsx';
import { Transcript, StatusChip } from './transcript.tsx';
import { TimelineDialog } from './timeline-dialog.tsx';
import { PromptNavigatorRail } from './prompt-rail.tsx';
import { OperatorRail } from './operator-rail.tsx';
import { startersFor, type Starter } from './starters.ts';
import type { ModelSelection } from './model-picker.tsx';
import { toast } from 'sonner';
import { recapFor } from './work-status.ts';
import { useGlobalSessionsStore } from '../sync/global-stores.ts';
import { ChildSessionControls } from './child-session-controls.tsx';
import { SessionGoalControls } from './session-goal-controls.tsx';
import { useSettingsStore } from '../lib/settings/store.ts';
import { persistLastActiveSession } from '../sync/persist-cache.ts';
import { normalizeDirectory } from '../lib/nnd/client.ts';

/** §E.3/§E.4 band: recap note + suggestion chip (chip FILLS, never sends). */
function RecapNote({ pair }: { pair: { recap: string; suggestion: string } }): ReactNode {
  return (
    <div className="mb-2 flex flex-col gap-1 rounded-lg bg-white/5 px-3 py-2" data-testid="recap-note">
      <div className="text-[11px] text-neutral-400">
        <span className="text-neutral-500">Recap: </span>
        {pair.recap}
      </div>
      {pair.suggestion ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            title="Use suggested message"
            aria-label="Use suggested message"
            className="rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-neutral-200 hover:border-white/25"
            onClick={() => window.dispatchEvent(new CustomEvent('nnd:composer-fill', { detail: { text: pair.suggestion } }))}
          >
            {pair.suggestion}
          </button>
          <span className="text-[10px] text-neutral-600">fills the composer — nothing sends without you</span>
        </div>
      ) : null}
    </div>
  );
}

const SESSION_SWITCH_HOLD_MS = 400;

export interface ChatViewProps {
  services: ComposerServices;
  currentDirectory: string;
}

interface ChatColumnSession {
  sessionID: string | null;
  store: StoreApi<DirectoryStore> | null;
  directory: string;
  key: string;
}

export function ChatView(props: ChatViewProps): ReactNode {
  const view = useSyncExternalStore(useSessionViewStore.subscribe, useSessionViewStore.getState);
  const globalSessions = useSyncExternalStore(useGlobalSessionsStore.subscribe, useGlobalSessionsStore.getState);
  const goalEnabled = useSettingsStore((state) => state.doc.sessionGoalEnabled === true);
  const [shown, setShown] = useState<ChatColumnSession | null>(null);
  const [timelineOpen, setTimelineOpen] = useState(false);
  useEffect(() => {
    const open = (): void => setTimelineOpen(true);
    window.addEventListener('nnd:timeline-open', open);
    return () => window.removeEventListener('nnd:timeline-open', open);
  }, []);
  const [expanded, setExpanded] = useState(false);
  const [compactSurfaceOpen, setCompactSurfaceOpen] = useState(false);
  const chatRoot = useRef<HTMLElement>(null);
  const compactOpenButton = useRef<HTMLButtonElement>(null);
  const focusReturnOnOpen = useRef(false);
  const returnToChatFocus = useRef(false);
  useEffect(() => {
    if (compactSurfaceOpen) {
      if (focusReturnOnOpen.current) {
        focusReturnOnOpen.current = false;
        chatRoot.current?.querySelector<HTMLButtonElement>('[data-testid="operator-return-chat"]')?.focus();
      }
    } else if (returnToChatFocus.current) {
      returnToChatFocus.current = false;
      if (window.matchMedia?.('(min-width: 1100px)').matches) {
        (chatRoot.current?.querySelector<HTMLElement>('[data-testid="composer-editor"]') ?? chatRoot.current)?.focus();
      } else {
        compactOpenButton.current?.focus();
      }
    }
  }, [compactSurfaceOpen]);
  useEffect(() => {
    const wide = window.matchMedia?.('(min-width: 1100px)');
    if (!wide) return;
    const revealFocusedRail = (event: MediaQueryListEvent): void => {
      if (event.matches) {
        setCompactSurfaceOpen(false);
        return;
      }
      const rail = chatRoot.current?.querySelector('[data-testid="operator-rail"]');
      if (rail?.contains(document.activeElement)) setCompactSurfaceOpen(true);
    };
    wide.addEventListener('change', revealFocusedRail);
    return () => wide.removeEventListener('change', revealFocusedRail);
  }, []);
  const [modelSelection, setModelSelection] = useState<ModelSelection | null>(null);
  const holdRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const starters: Starter[] = useMemo(() => startersFor(view.activeDirectory || '/'), [view.activeDirectory]);

  useEffect(() => {
    const keyNow = `${view.activeDirectory}\n${view.currentSessionId ?? 'draft'}`;
    if (shown && shown.key === keyNow) return;
    const store = props.services.engine.childStoreOf(view.activeDirectory) ?? props.services.engine.manager.ensureChild(view.activeDirectory);
    // §A.2: swap as one unit. Hold only when the target session has NO loaded
    // snapshot yet (not warm); warm columns swap instantly.
    const target = view.currentSessionId;
    const warm = target === null || store.getState().message[target] !== undefined
      || store.getState().sessionListSource === ('authoritative' as SessionListSource);
    if (shown === null || warm) {
      setShown({ sessionID: target, store, directory: view.activeDirectory, key: keyNow });
      return;
    }
    if (holdRef.current !== null) clearTimeout(holdRef.current);
    holdRef.current = setTimeout(() => {
      holdRef.current = null;
      const latest = useSessionViewStore.getState();
      setShown({ sessionID: latest.currentSessionId, store, directory: latest.activeDirectory, key: `${latest.activeDirectory}\n${latest.currentSessionId ?? 'draft'}` });
    }, SESSION_SWITCH_HOLD_MS);
    return () => {
      if (holdRef.current !== null) clearTimeout(holdRef.current);
      holdRef.current = null;
    };
  }, [view.currentSessionId, view.activeDirectory, props.services.engine, shown]);

  const runBtw = (parentSessionID: string): void => {
    void props.services.engine.actions
      .fork(parentSessionID, undefined)
      .then((childID) => {
        useSessionViewStore.getState().setCurrentSession(childID);
      })
      .catch(() => toast.error('Failed to start the fork session'));
  };

  const shownRef = shown;
  if (!shownRef || !shownRef.store) {
    return <div className="flex h-full min-w-0 flex-1 items-center justify-center text-sm text-neutral-600" data-testid="chat-view">Preparing…</div>;
  }
  const selected = shownRef.sessionID
    ? shownRef.store.getState().session.find((session) => session.id === shownRef.sessionID)
      ?? globalSessions.active.find((session) => session.id === shownRef.sessionID)
      ?? globalSessions.archived.find((session) => session.id === shownRef.sessionID)
    : null;
  // A selected id can arrive before its session projection. Do not briefly
  // expose a composer and let an unclassified child receive a prompt.
  const sessionMetadataLoading = shownRef.sessionID !== null && selected === null;
  const isChildSession = selected?.parentID !== undefined;
  // Focus mode belongs to the parent composer. A child has no composer to
  // collapse it, so keep the child transcript and operator rail accessible.
  const focusMode = expanded && !isChildSession;
  const parentSession = selected?.parentID
    ? shownRef.store.getState().session.find((session) => session.id === selected.parentID)
      ?? [...globalSessions.active, ...globalSessions.archived].find((session) => session.id === selected.parentID
        && normalizeDirectory(session.directory ?? '') === normalizeDirectory(shownRef.directory))
    : null;
  const globalGoalSession = shownRef.sessionID
    ? globalSessions.active.find((session) => session.id === shownRef.sessionID)
      ?? globalSessions.archived.find((session) => session.id === shownRef.sessionID)
    : null;
  const globalNnd = globalGoalSession?.metadata?.['nnd'];
  const globalGoalRevision = globalNnd && typeof globalNnd === 'object'
    ? (globalNnd as Record<string, unknown>)['goalRevision'] : undefined;
  const draftLanding = shownRef.sessionID === null && !focusMode;
  const workspaceName = shownRef.directory.replace(/[\\/]+$/u, '').split(/[\\/]/u).filter(Boolean).at(-1) ?? 'this workspace';

  return (
    <section ref={chatRoot} tabIndex={-1} className={`relative flex h-full min-w-0 flex-1 flex-row ${focusMode ? 'bg-neutral-950' : ''}`} data-testid="chat-view">
      <div className={`relative min-w-0 flex-1 flex-col ${compactSurfaceOpen && !focusMode ? 'hidden min-[1100px]:flex' : 'flex'}`}>
        {!focusMode ? <div className="flex justify-end border-b border-white/10 px-3 py-1 min-[1100px]:hidden">
          <button ref={compactOpenButton} type="button" data-testid="open-operator-surfaces" className="rounded px-2 py-1 text-xs text-neutral-300 hover:bg-white/10" onClick={() => { focusReturnOnOpen.current = true; setCompactSurfaceOpen(true); }}>Surfaces</button>
        </div> : null}
        {isChildSession && selected && shownRef.sessionID ? <header className="border-b border-white/10 bg-neutral-950 px-4 py-3" data-testid="child-transcript-header">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0"><span className="text-[10px] uppercase tracking-wide text-neutral-500">Subagent transcript{selected.agent ? ` · ${selected.agent}` : ''}</span>
                <h2 className="truncate text-sm text-neutral-200">{selected.title || 'Subagent'}</h2></div>
              {parentSession ? <button type="button" className="rounded border border-white/15 px-2 py-1 text-xs text-neutral-300 hover:border-white/30"
                data-testid="return-to-parent" onClick={() => {
                  persistLastActiveSession(parentSession.id, shownRef.directory);
                  useSessionViewStore.setState({ currentSessionId: parentSession.id, activeDirectory: shownRef.directory });
                }}>← Return to {parentSession.title || 'parent session'}</button>
                : <span className="text-xs text-neutral-500" data-testid="parent-unavailable">Parent session unavailable</span>}
            </div>
            <StatusChip store={shownRef.store} sessionID={shownRef.sessionID} />
            <ChildSessionControls key={`${shownRef.directory}\n${shownRef.sessionID}`} sessionID={shownRef.sessionID} directory={shownRef.directory} />
          </div>
        </header> : null}
        <div className={`min-h-0 flex-1 overflow-y-auto ${isChildSession ? 'pb-6' : 'pb-40'} ${focusMode || draftLanding ? 'hidden' : ''}`} data-chat-column>
          {!draftLanding ? <Transcript store={shownRef.store} engine={props.services.engine} sessionID={shownRef.sessionID} directory={shownRef.directory} /> : null}
        </div>
        <PromptNavigatorRail store={shownRef.store} sessionID={shownRef.sessionID} />
        {!isChildSession ? <div className={`relative z-10 px-4 ${draftLanding ? 'flex min-h-0 flex-1 overflow-y-auto py-6' : 'border-t border-white/5 bg-neutral-950/80 py-3'}`} data-composer-bound>
          <div className={`${draftLanding ? 'my-auto' : ''} mx-auto w-full max-w-3xl`}>
          {draftLanding ? <div className="mb-7" data-testid="chat-draft-landing">
            <h1 className="text-2xl font-medium tracking-tight text-neutral-200 sm:text-3xl">What should we work on in {workspaceName}?</h1>
            <p className="mt-2 text-xs text-neutral-500">Your workspace is ready. Start with a message or choose a suggestion.</p>
          </div> : null}
          <StatusChip store={shownRef.store} sessionID={shownRef.sessionID} />
          {goalEnabled && shownRef.sessionID && !isChildSession && !sessionMetadataLoading ? <SessionGoalControls key={shownRef.sessionID} sessionID={shownRef.sessionID} store={shownRef.store} externalRevision={typeof globalGoalRevision === 'number' && Number.isSafeInteger(globalGoalRevision) && globalGoalRevision >= 0 ? globalGoalRevision : 0} /> : null}
          {!focusMode && shownRef.sessionID && recapFor(shownRef.store.getState(), shownRef.sessionID) ? (
            <RecapNote pair={recapFor(shownRef.store.getState(), shownRef.sessionID)!} />
          ) : null}
          {sessionMetadataLoading ? <div className="text-xs text-neutral-500" data-testid="session-metadata-loading">Session access metadata is loading.</div> : <Composer
            services={props.services}
            sessionID={shownRef.sessionID}
            directory={shownRef.directory}
            sessionKey={shownRef.sessionID ?? 'draft'}
            expanded={focusMode}
            onToggleExpanded={() => { setCompactSurfaceOpen(false); setExpanded((value) => !value); }}
            onRunBtw={runBtw}
            onOpenTimeline={() => setTimelineOpen(true)}
            starters={shownRef.sessionID === null ? starters : []}
            modelSelection={modelSelection}
            onModelSelection={setModelSelection}
            onAddProvider={() => toast('Provider management opens with the settings pages (P5)')}
          />}
          </div>
        </div> : null}
      </div>
      <OperatorRail store={shownRef.store} engine={props.services.engine} directory={shownRef.directory}
        displayedSessionID={shownRef.sessionID}
        compactOpen={compactSurfaceOpen} suppressed={focusMode}
        onCloseCompact={() => { returnToChatFocus.current = true; setCompactSurfaceOpen(false); }} />
      {timelineOpen && shownRef.sessionID ? (
        <TimelineDialog store={shownRef.store} engine={props.services.engine} sessionID={shownRef.sessionID} onClose={() => setTimelineOpen(false)} />
      ) : null}
    </section>
  );
}
