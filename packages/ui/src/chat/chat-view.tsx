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
import { WorkStatusPanel } from './work-status-panel.tsx';
import { startersFor, type Starter } from './starters.ts';
import type { ModelSelection } from './model-picker.tsx';
import { toast } from 'sonner';
import { recapFor } from './work-status.ts';

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
  const [shown, setShown] = useState<ChatColumnSession | null>(null);
  const [timelineOpen, setTimelineOpen] = useState(false);
  useEffect(() => {
    const open = (): void => setTimelineOpen(true);
    window.addEventListener('nnd:timeline-open', open);
    return () => window.removeEventListener('nnd:timeline-open', open);
  }, []);
  const [expanded, setExpanded] = useState(false);
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

  return (
    <section className={`relative flex h-full min-w-0 flex-1 flex-row ${expanded ? 'bg-neutral-950' : ''}`} data-testid="chat-view">
      <div className="relative flex min-w-0 flex-1 flex-col">
        <div className={`min-h-0 flex-1 overflow-y-auto pb-40 ${expanded ? 'hidden' : ''}`} data-chat-column>
          <Transcript store={shownRef.store} engine={props.services.engine} sessionID={shownRef.sessionID} directory={shownRef.directory} />
        </div>
        <PromptNavigatorRail store={shownRef.store} sessionID={shownRef.sessionID} />
        <div className="relative z-10 border-t border-white/10 bg-neutral-950/60 px-4 py-3" data-composer-bound>
          <StatusChip store={shownRef.store} sessionID={shownRef.sessionID} />
          {!expanded && shownRef.sessionID && recapFor(shownRef.store.getState(), shownRef.sessionID) ? (
            <RecapNote pair={recapFor(shownRef.store.getState(), shownRef.sessionID)!} />
          ) : null}
          <Composer
            services={props.services}
            sessionID={shownRef.sessionID}
            directory={shownRef.directory}
            sessionKey={shownRef.sessionID ?? 'draft'}
            expanded={expanded}
            onToggleExpanded={() => setExpanded((value) => !value)}
            onRunBtw={runBtw}
            onOpenTimeline={() => setTimelineOpen(true)}
            starters={shownRef.sessionID === null ? starters : []}
            modelSelection={modelSelection}
            onModelSelection={setModelSelection}
            onAddProvider={() => toast('Provider management opens with the settings pages (P5)')}
          />
        </div>
      </div>
      {expanded ? null : <WorkStatusPanel store={shownRef.store} engine={props.services.engine} />}
      {timelineOpen && shownRef.sessionID ? (
        <TimelineDialog store={shownRef.store} engine={props.services.engine} sessionID={shownRef.sessionID} onClose={() => setTimelineOpen(false)} />
      ) : null}
    </section>
  );
}
