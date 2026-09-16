// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Toaster, toast } from 'sonner';
import { mountEngine } from '../chat/app-engine.ts';
import { ChatView } from '../chat/chat-view.tsx';
import { ChatSidebar, bindBlockedProbe } from '../chat/session-sidebar.tsx';
import { SessionTabs } from '../chat/session-tabs.tsx';
import { normalizeDirectory } from '../lib/nnd/client.ts';
import { useSessionViewStore } from '../sync/view-store.ts';
import { useGlobalSyncStore } from '../sync/global-stores.ts';
import { useConfigStore } from '../stores/useConfigStore.ts';
import type { ComposerServices } from '../chat/composer.tsx';

/** MainLayout (doc 01 §13.1) with the P3a chat product wired in. */
export function MainLayout(): ReactNode {
  const engine = mountEngine();
  const view = useSyncExternalStore(useSessionViewStore.subscribe, useSessionViewStore.getState);
  const global = useSyncExternalStore(useGlobalSyncStore.subscribe, useGlobalSyncStore.getState);
  const connected = useSyncExternalStore(useConfigStore.subscribe, () => useConfigStore.getState().isConnected);
  const [services] = useState<ComposerServices>(() => ({
    engine,
    store: (directory?: string) => {
      const current = directory ?? useSessionViewStore.getState().activeDirectory;
      return engine.childStoreOf(current || '/') ?? engine.manager.ensureChild(current || '/');
    },
    dispatch: (command) => {
      if (command === 'timeline') toast.message('Timeline dialog arrives in P3b');
      if (command === 'compact') toast.message('Compaction runs harness-side in P4+');
      if (command === 'undo' || command === 'redo') toast.message('Revert/undo rides the harness action surface in P3b');
    },
  }));

  useEffect(() => {
    bindBlockedProbe((sessionID) => engine.routing.sessionDirectoryById.get(sessionID) ?? null);
  }, [engine]);

  useEffect(() => {
    if (view.activeDirectory) return;
    const path = global.path as Record<string, unknown> | null;
    const directory = typeof path?.['directory'] === 'string' ? String(path['directory']) : '';
    if (directory) useSessionViewStore.getState().setActiveDirectory(directory);
  }, [global.path, view.activeDirectory]);

  const actions = {
    openDraft: (directory: string) => {
      useSessionViewStore.setState({ currentSessionId: null, activeDirectory: directory });
    },
    openSession: (sessionID: string, directory: string) => {
      // §F.4: navigation NEVER denies pending requests — dismiss is authority
      // of the send path and the explicit card buttons only.
      useSessionViewStore.setState({ currentSessionId: sessionID, activeDirectory: directory });
    },
    rename: async (sessionID: string, title: string) => {
      void sessionID; void title;
      toast.message('Session PATCH channel lands with P4; title queued');
    },
    archive: async (sessionID: string, directory: string) => {
      await engine.actions.archive(sessionID, directory);
    },
    deleteSession: async (sessionID: string, directory: string) => {
      await engine.actions.deleteSession(sessionID, directory);
    },
  };

  const activeDirectory = normalizeDirectoryInput(view.activeDirectory || globalHome(global) || '/');

  return (
    <div className="flex h-screen flex-col flex-1 bg-neutral-900 text-neutral-100">
      <header className="flex items-center gap-2 border-b border-white/10 bg-neutral-950/70 px-3 py-1.5" data-testid="app-header">
        <div className="text-[11px] uppercase tracking-widest text-amber-400/80">NotNative</div>
        <SessionTabs engine={engine} directory={activeDirectory} />
        <span className={`ml-auto rounded-full px-2 py-0.5 text-[10px] ${connected ? 'bg-emerald-900/50 text-emerald-300' : 'bg-red-900/40 text-red-300'}`} data-testid="connection-pill">
          {connected ? 'connected' : 'reconnecting'}
        </span>
      </header>
      <div className="flex min-h-0 flex-1">
        <ChatSidebar engine={engine} currentDirectory={activeDirectory} currentSessionId={view.currentSessionId} actions={actions} />
        <ChatView services={services} currentDirectory={activeDirectory} />
      </div>
      <Toaster position="bottom-right" />
    </div>
  );
}

function normalizeDirectoryInput(directory: string): string {
  return directory.replaceAll('\\', '/');
}

function globalHome(global: ReturnType<typeof useGlobalSyncStore.getState>): string {
  return typeof global.path?.['directory'] === 'string' ? String(global.path['directory']) : '';
}
