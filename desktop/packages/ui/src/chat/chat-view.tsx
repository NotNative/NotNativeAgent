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
import { createBtwSession } from './btw-actions.ts';
import { useSessionOrgStore } from '../stores/useSessionOrgStore.ts';
import { parseBtwMetadata } from './btw-context.ts';
import { BtwPanel } from './btw-panel.tsx';
import type { SyncEngine } from '../sync/sync-engine.ts';
import { useMemo } from 'react';
import { Composer, type BtwInvocation, type ComposerServices } from './composer.tsx';
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
import { useContextRoute } from '../components/use-context-route.ts';
import { CompletionAffordance } from './completion-affordance.tsx';
import { useConversationDraftStore } from '../stores/useConversationDraftStore.ts';
import { readDraft, saveDraft, flushDraftsNow, subscribeDraftChanges, getDraftRevision } from './drafts.ts';
import { DraftWorkspacePicker } from './draft-workspace-picker.tsx';
import { notifySessionRouteNavigation } from '../lib/session-route.ts';

/** H.2/E.3/E.4 band: recap text and/or suggestion chip; chips only fill. */
function RecapNote({ pair }: { pair: { recap: string | null; suggestion: string | null } }): ReactNode {
  return (
    <div className="mb-2 flex flex-col gap-1 rounded-lg bg-muted/50 px-3 py-2" data-testid="recap-note">
      {pair.recap ? (
        <div className="text-[11px] text-muted-foreground">
          <span className="text-muted-foreground">Recap: </span>
          {pair.recap}
        </div>
      ) : null}
      {pair.suggestion ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            title="Use suggested message"
            aria-label="Use suggested message"
            className="rounded-full border border-border/50 px-2 py-0.5 text-[11px] text-foreground hover:border-white/25"
            onClick={() => window.dispatchEvent(new CustomEvent('nnd:composer-fill', { detail: { text: pair.suggestion } }))}
          >
            {pair.suggestion}
          </button>
          <span className="text-[10px] text-muted-foreground">fills the composer — nothing sends without you</span>
        </div>
      ) : null}
    </div>
  );
}

const SESSION_SWITCH_HOLD_MS = 400;

export interface ChatViewProps {
  services: ComposerServices;
  currentDirectory: string;
  nativeAlpha?: boolean;
}

interface ChatColumnSession {
  sessionID: string | null;
  store: StoreApi<DirectoryStore> | null;
  directory: string;
  key: string;
}

export function ChatView(props: ChatViewProps): ReactNode {
  useSyncExternalStore(subscribeDraftChanges, getDraftRevision);
  const view = useSyncExternalStore(useSessionViewStore.subscribe, useSessionViewStore.getState);
  const globalSessions = useSyncExternalStore(useGlobalSessionsStore.subscribe, useGlobalSessionsStore.getState);
  const goalEnabled = useSettingsStore((state) => state.doc.sessionGoalEnabled === true);
  const recapEnabled = useSettingsStore((state) => state.doc.sessionRecapEnabled !== false);
  const suggestionEnabled = useSettingsStore((state) => state.doc.sessionSuggestionEnabled !== false);
  const wide = useSettingsStore(state => state.doc.wideChatLayoutEnabled === true);
  const [shown, setShown] = useState<ChatColumnSession | null>(null);
  const [timelineOpen, setTimelineOpen] = useState(false);
  useEffect(() => {
    const open = (): void => setTimelineOpen(true);
    window.addEventListener('nnd:timeline-open', open);
    return () => window.removeEventListener('nnd:timeline-open', open);
  }, []);
  const [expanded, setExpanded] = useState(false);
  const [compactSurfaceOpen, setCompactSurfaceOpen] = useState(false);
  useContextRoute(shown?.directory, shown?.sessionID, (request) => {
    setExpanded(false);
    setCompactSurfaceOpen(request.tab !== 'chat' && !(window.matchMedia?.('(min-width: 1100px)').matches ?? false));
  });
  const chatRoot = useRef<HTMLElement>(null);
  const focusNewConversation = useRef(false);
  const compactOpenButton = useRef<HTMLButtonElement>(null);
  const focusReturnOnOpen = useRef(false);
  const returnToChatFocus = useRef(false);
  useEffect(() => {
    const focus = (): void => {
      focusNewConversation.current = true;
      setCompactSurfaceOpen(false);
      requestAnimationFrame(() => {
        if (!focusNewConversation.current) return;
        const editor = chatRoot.current?.querySelector<HTMLElement>('[data-testid="composer-editor"]');
        if (editor) { editor.focus(); focusNewConversation.current = false; }
      });
    };
    window.addEventListener('nnd:focus-new-conversation', focus);
    return () => window.removeEventListener('nnd:focus-new-conversation', focus);
  }, []);
  useEffect(() => {
    if (!focusNewConversation.current || shown?.sessionID !== null) return;
    const frame = requestAnimationFrame(() => {
      const editor = chatRoot.current?.querySelector<HTMLElement>('[data-testid="composer-editor"]');
      if (editor) { editor.focus(); focusNewConversation.current = false; }
    });
    return () => cancelAnimationFrame(frame);
  }, [shown?.key]);
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
    if (view.activeDirectory !== '') void useSessionOrgStore.getState().load(view.activeDirectory);
  }, [view.activeDirectory]);

  useEffect(() => {
    const keyNow = `${view.activeDirectory}\n${view.currentSessionId ?? view.currentDraftId ?? 'draft'}`;
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
      setShown({ sessionID: latest.currentSessionId, store, directory: latest.activeDirectory, key: `${latest.activeDirectory}\n${latest.currentSessionId ?? latest.currentDraftId ?? 'draft'}` });
    }, SESSION_SWITCH_HOLD_MS);
    return () => {
      if (holdRef.current !== null) clearTimeout(holdRef.current);
      holdRef.current = null;
    };
  }, [view.currentSessionId, view.currentDraftId, view.activeDirectory, props.services.engine, shown]);

  const runBtw = (parentSessionID: string, input: BtwInvocation): void => {
    const current = shown;
    if (!current) return;
    const runtimeKey = `${current.directory}\n${parentSessionID}`;
    const isCurrent = (value: string): boolean => value === runtimeKey;
    const store = props.services.store(current.directory);
    void createBtwSession({
      parent: { sessionID: parentSessionID, directory: current.directory, runtimeKey },
      question: input.question,
      model: input.model,
      agent: input.sendAgent,
      store,
      engine: props.services.engine,
      isCurrent,
    }).then((child) => {
      useSessionViewStore.setState({ currentSessionId: child.id, activeDirectory: current.directory });
    }).catch((error: unknown) => toast.error(error instanceof Error ? error.message : 'Failed to start the fork session'));
  };

  const shownRef = shown;
  const orgBtwChildOf = useSessionOrgStore((state) => shownRef && shownRef.directory
    ? state.recordsByDirectory[normalizeDirectory(shownRef.directory)]?.[shownRef.sessionID ?? '']?.btwChildOf
    : undefined);
  if (!shownRef || !shownRef.store) {
    return <div className="flex h-full min-w-0 flex-1 items-center justify-center text-sm text-muted-foreground" data-testid="chat-view">Preparing…</div>;
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
  const now = Date.now();
  const recap = shownRef.sessionID ? recapFor(shownRef.store.getState(), shownRef.sessionID,
    now, { recap: recapEnabled, suggestion: suggestionEnabled }) : null;
  const workspaceName = shownRef.directory.replace(/[\\/]+$/u, '').split(/[\\/]/u).filter(Boolean).at(-1) ?? 'this workspace';
  const btwChildSessionID = (() => {
    if (typeof orgBtwChildOf === 'string' && orgBtwChildOf !== '') return orgBtwChildOf;
    const openchamber = selected?.metadata?.openchamber;
    if (!openchamber || typeof openchamber !== 'object' || Array.isArray(openchamber)) return undefined;
    const value = (openchamber as Record<string, unknown>).btwSessionID;
    return typeof value === 'string' && value !== '' ? value : undefined;
  })();
  const btwChildSession = btwChildSessionID
    ? shownRef.store.getState().session.find((session) => session.id === btwChildSessionID)
    : undefined;

  return (
    <section ref={chatRoot} tabIndex={-1} className={`relative flex min-h-0 min-w-0 flex-1 flex-row ${focusMode ? 'bg-background' : ''}`} data-testid="chat-view">
      <div className={`relative min-h-0 min-w-0 flex-1 flex-col ${compactSurfaceOpen && !focusMode ? 'hidden min-[1100px]:flex' : 'flex'}`}>
        {!focusMode && !(props.nativeAlpha && draftLanding) ? <div className="flex justify-end border-b border-border/50 px-3 py-1 min-[1100px]:hidden">
          <button ref={compactOpenButton} type="button" data-testid="open-operator-surfaces" className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted" onClick={() => { focusReturnOnOpen.current = true; setCompactSurfaceOpen(true); }}>Surfaces</button>
        </div> : null}
        {isChildSession && selected && shownRef.sessionID ? <header className="border-b border-border/50 bg-background px-4 py-3" data-testid="child-transcript-header">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0"><span className="text-[10px] uppercase tracking-wide text-muted-foreground">Subagent transcript{selected.agent ? ` · ${selected.agent}` : ''}</span>
                <h2 className="truncate text-sm text-foreground">{selected.title || 'Subagent'}</h2></div>
              {parentSession ? <button type="button" className="rounded border border-border/60 px-2 py-1 text-xs text-muted-foreground hover:border-white/30"
                data-testid="return-to-parent" onClick={() => {
                  persistLastActiveSession(parentSession.id, shownRef.directory);
                  useSessionViewStore.setState({ currentSessionId: parentSession.id, activeDirectory: shownRef.directory });
                }}>← Return to {parentSession.title || 'parent session'}</button>
                : <span className="text-xs text-muted-foreground" data-testid="parent-unavailable">Parent session unavailable</span>}
            </div>
            <StatusChip store={shownRef.store} sessionID={shownRef.sessionID} />
            <ChildSessionControls key={`${shownRef.directory}\n${shownRef.sessionID}`} sessionID={shownRef.sessionID} directory={shownRef.directory} />
          </div>
        </header> : null}
        {btwChildSession && btwChildSessionID ? <div className="mx-auto w-full max-w-3xl px-4 pt-3">
          <BtwPanel store={shownRef.store} engine={props.services.engine}
            parentSessionID={shownRef.sessionID!} childSessionID={btwChildSessionID}
            session={btwChildSession}
            directory={shownRef.directory}
            onSelectSession={(sessionID) => useSessionViewStore.setState({ currentSessionId: sessionID, activeDirectory: shownRef.directory })} />
        </div> : null}
        <div className={`min-h-0 flex-1 overflow-y-auto overscroll-contain ${isChildSession ? 'pb-6' : 'pb-40'} ${focusMode || draftLanding ? 'hidden' : ''}`} data-chat-column>
          {!draftLanding ? <Transcript store={shownRef.store} engine={props.services.engine} sessionID={shownRef.sessionID} directory={shownRef.directory} /> : null}
          <CompletionAffordance store={shownRef.store} sessionID={shownRef.sessionID} />
        </div>
        <PromptNavigatorRail store={shownRef.store} sessionID={shownRef.sessionID} />
        {!isChildSession ? <div className={`relative z-10 px-4 ${draftLanding ? 'flex min-h-0 flex-1 overflow-y-auto overscroll-contain py-6' : 'shrink-0 border-t border-border/30 bg-background/80 py-3'}`} data-composer-bound>
          <div className={`${draftLanding ? 'my-auto' : ''} mx-auto w-full ${wide ? 'max-w-none' : 'max-w-3xl'}`}>
          {draftLanding ? <div className="mb-2" data-testid="chat-draft-landing">
            <h1 className="mb-8 text-center text-2xl font-medium tracking-tight text-foreground sm:text-3xl">What would you like to work on?</h1>
            <div className="flex flex-wrap items-center gap-5 px-2">
              {props.nativeAlpha ? <DraftWorkspacePicker directory={shownRef.directory} onSelect={directory => {
                if (readDraft(shownRef.directory, view.currentDraftId ?? 'draft').start) { toast.error('Recover the current start before changing its workspace.'); return; }
                if (view.currentDraftId) {
                  try { useConversationDraftStore.getState().move(view.currentDraftId, directory); } catch (error) { toast.error(String(error)); return; }
                } else { saveDraft(directory, 'draft', readDraft(shownRef.directory, 'draft')); flushDraftsNow(); }
                persistLastActiveSession(null, directory);
                useSessionViewStore.setState({ activeDirectory: directory, currentSessionId: null });
                notifySessionRouteNavigation();
              }} /> : <span className="text-sm text-foreground">{workspaceName}</span>}
              {props.nativeAlpha ? <span className="text-xs text-muted-foreground" title="NNA's standard agent, with mandatory reviewer governance">Standard mode</span> : null}
            </div>
          </div> : null}
          <StatusChip store={shownRef.store} sessionID={shownRef.sessionID} />
          {goalEnabled && shownRef.sessionID && !isChildSession && !sessionMetadataLoading ? <SessionGoalControls key={shownRef.sessionID} sessionID={shownRef.sessionID} store={shownRef.store} externalRevision={typeof globalGoalRevision === 'number' && Number.isSafeInteger(globalGoalRevision) && globalGoalRevision >= 0 ? globalGoalRevision : 0} /> : null}
          {!focusMode && recap ? <RecapNote pair={recap} /> : null}
          {sessionMetadataLoading ? <div className="text-xs text-muted-foreground" data-testid="session-metadata-loading">Session access metadata is loading.</div> : props.nativeAlpha && shownRef.sessionID === null && !view.currentDraftId ? <p role="status" className="text-sm text-muted-foreground">Preparing conversation… You can also choose New conversation.</p> : <Composer
            key={`${shownRef.directory}\n${shownRef.sessionID ?? view.currentDraftId ?? 'draft'}`}
            services={props.services}
            sessionID={shownRef.sessionID}
            directory={shownRef.directory}
            sessionKey={shownRef.sessionID ?? view.currentDraftId ?? 'draft'}
            expanded={focusMode}
            onToggleExpanded={() => { setCompactSurfaceOpen(false); setExpanded((value) => !value); }}
            onRunBtw={runBtw}
            onOpenTimeline={() => setTimelineOpen(true)}
            starters={shownRef.sessionID === null && !props.nativeAlpha ? starters : []}
            modelSelection={modelSelection}
            onModelSelection={setModelSelection}
            onAddProvider={() => toast('Provider management opens with the settings pages (P5)')}
          />}
          </div>
        </div> : null}
      </div>
      {!(props.nativeAlpha && draftLanding) ? <OperatorRail nativeAlpha={props.nativeAlpha} store={shownRef.store} engine={props.services.engine} directory={shownRef.directory}
        displayedSessionID={shownRef.sessionID}
        compactOpen={compactSurfaceOpen} suppressed={focusMode}
        onCloseCompact={() => { returnToChatFocus.current = true; setCompactSurfaceOpen(false); }} /> : null}
      {timelineOpen && shownRef.sessionID ? (
        <TimelineDialog store={shownRef.store} engine={props.services.engine} sessionID={shownRef.sessionID} onClose={() => setTimelineOpen(false)} />
      ) : null}
    </section>
  );
}
