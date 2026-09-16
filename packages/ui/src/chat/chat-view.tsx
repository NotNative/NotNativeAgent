// SPDX-License-Identifier: Apache-2.0
/**
 * Chat session view (doc 05 §A.2, v1): transcript + status chip + composer
 * with the deferred session-switch hold (400ms), draft welcome, and per-
 * session composer slot. Virtualization, peek, mini chrome land next.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import { useSyncExternalStore } from 'react';
import type { DirectoryStore } from '../sync/types.ts';
import { useSessionViewStore } from '../sync/view-store.ts';
import type { SyncEngine } from '../sync/sync-engine.ts';
import { Composer, type ComposerServices } from './composer.tsx';
import { Transcript, StatusChip } from './transcript.tsx';

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
  const holdRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const currentKeyKey = view.currentSessionId ?? 'draft';
    const existingController = shown?.sessionID === view.currentSessionId && shown?.directory === view.activeDirectory;
    if (existingController && shown) return;
    const store = props.services.engine.childStoreOf(view.activeDirectory) ?? props.services.engine.manager.ensureChild(view.activeDirectory);
    const applyImmediately = shown === null || view.currentSessionId === null;
    if (applyImmediately) {
      setShown({ sessionID: view.currentSessionId, store, directory: view.activeDirectory, key: `${view.activeDirectory}\n${currentKeyKey}` });
      return;
    }
    if (holdRef.current !== null) clearTimeout(holdRef.current);
    holdRef.current = setTimeout(() => {
      holdRef.current = null;
      setShown({ sessionID: useSessionViewStore.getState().currentSessionId, store, directory: useSessionViewStore.getState().activeDirectory, key: `${useSessionViewStore.getState().activeDirectory}\n${useSessionViewStore.getState().currentSessionId ?? 'draft'}` });
    }, SESSION_SWITCH_HOLD_MS);
    return () => {
      if (holdRef.current !== null) clearTimeout(holdRef.current);
      holdRef.current = null;
    };
  }, [view.currentSessionId, view.activeDirectory, props.services.engine, shown]);

  const shownRef = shown;
  if (!shownRef || !shownRef.store) {
    return <div className="flex h-full min-w-0 flex-1 items-center justify-center text-sm text-neutral-600" data-testid="chat-view">Preparing…</div>;
  }

  return (
    <section className="relative flex h-full min-w-0 flex-1 flex-col" data-testid="chat-view">
      <div className="min-h-0 flex-1 overflow-y-auto pb-40" data-chat-column>
        <Transcript store={shownRef.store} engine={props.services.engine} sessionID={shownRef.sessionID} directory={shownRef.directory} />
      </div>
      <div className="relative border-t border-white/10 bg-neutral-950/60 px-4 py-3" data-composer-bound>
        <StatusChip store={shownRef.store} sessionID={shownRef.sessionID} />
        <Composer
          services={props.services}
          sessionID={shownRef.sessionID}
          directory={shownRef.directory}
          sessionKey={shownRef.sessionID ?? 'draft'}
        />
      </div>
    </section>
  );
}
