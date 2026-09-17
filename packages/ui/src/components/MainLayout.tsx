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
import { ShellShortcuts, settingsOpenEventName } from './ShellShortcuts.tsx';
import { SettingsWindow } from './settings/window.tsx';
import { FilesView } from './files/FilesView.tsx';
import { DiffView } from './diff/DiffView.tsx';
import { GitView } from './git/GitView.tsx';
import { BUILT_PAGE_SLUGS, type SettingsPageSlug } from './settings/search.ts';
import { bindSettingsBridge } from '../lib/settings/store.ts';
import { bindAppearanceAppliers } from '../lib/settings/apply.ts';
import type { ComposerServices } from '../chat/composer.tsx';

/** MainLayout (doc 01 §13.1) with the P3a chat product, the P5-6
 * SettingsWindow (gear / mod+, / ?settings=<slug>) and the P6-1 FilesView
 * (Files button; full surface with the tree over the chat column). */
export function MainLayout(): ReactNode {
  const engine = mountEngine();
  const view = useSyncExternalStore(useSessionViewStore.subscribe, useSessionViewStore.getState);
  const global = useSyncExternalStore(useGlobalSyncStore.subscribe, useGlobalSyncStore.getState);
  const connected = useSyncExternalStore(useConfigStore.subscribe, () => useConfigStore.getState().isConnected);
  const [settingsPage, setSettingsPage] = useState<SettingsPageSlug | null>(() => slugFromLocation());
  const [filesOpen, setFilesOpen] = useState(false);
  const [reviewPane, setReviewPane] = useState<'' | 'diff' | 'git'>('');

  const closeSettings = useCallback(() => setSettingsPage(null), []);
  const openSettings = useCallback((slug: SettingsPageSlug) => setSettingsPage(slug), []);

  useEffect(() => {
    bindSettingsBridge();
    bindAppearanceAppliers();
  }, []);

  useEffect(() => {
    const onOpen = (event: Event): void => {
      const detail = (event as CustomEvent<SettingsPageSlug | undefined>).detail;
      openSettings(detail ?? 'general');
    };
    window.addEventListener(settingsOpenEventName, onOpen);
    return () => window.removeEventListener(settingsOpenEventName, onOpen);
  }, [openSettings]);
  const [services] = useState<ComposerServices>(() => ({
    engine,
    store: () => {
      const current = useSessionViewStore.getState().activeDirectory;
      return engine.childStoreOf(current || '/') ?? engine.manager.ensureChild(current || '/');
    },
    dispatch: (command) => {
      const live = useSessionViewStore.getState();
      const sessionID = live.currentSessionId;
      const store = engine.childStoreOf(live.activeDirectory);
      if (command === 'timeline') {
        window.dispatchEvent(new CustomEvent('nnd:timeline-open'));
        return;
      }
      if (!sessionID || !store) {
        toast.message('Nothing selected to ' + command);
        return;
      }
      const snapshot = store.getState();
      const messages = snapshot.message[sessionID] ?? [];
      if (command === 'undo') {
        // §D.6 keep-point semantics: revert TO the last user message. The
        // harness retains the slice; the view announces RE-Truncation at that
        // point and the message text re-fills the composer.
        const lastUserIndex = (() => {
          for (let i = messages.length - 1; i >= 0; i -= 1) {
            if (messages[i]!.role === 'user') return i;
          }
          return -1;
        })();
        if (lastUserIndex < 0) { toast.message('Nothing to revert yet'); return; }
        const target = messages[lastUserIndex]!;
        const targetText = ((snapshot.part[target.id] ?? []) as { type: string; text?: string }[])
          .filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
        void engine.actions.revert(sessionID, target.id)
          .then(() => {
            const live = store.getState();
            const index = (live.message[sessionID] ?? []).findIndex((message) => message.id === target.id);
            if (index >= 0) {
              const truncated = (live.message[sessionID] ?? []).slice(0, index);
              const part = { ...live.part };
              for (const message of (live.message[sessionID] ?? []).slice(index)) delete part[message.id];
              store.setState({ message: { ...live.message, [sessionID]: truncated }, part });
            }
            window.dispatchEvent(new CustomEvent('nnd:composer-fill', { detail: { text: targetText } }));
          })
          .catch(() => toast.error('Failed to revert the conversation'));
        return;
      }
      if (command === 'redo') {
        void engine.actions.unrevert(sessionID)
          .then(() => engine.loader.refreshTail({ directory: live.activeDirectory, sessionID, store: engine.childStoreOf(live.activeDirectory) ?? engine.manager.ensureChild(live.activeDirectory) }, 50))
          .catch(() => toast.error('Failed to redo the reverted slice'));
        return;
      }
      if (command === 'compact') toast.message('Compaction runs harness-side in P4+');
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
      <ShellShortcuts />
      <header className="flex items-center gap-2 border-b border-white/10 bg-neutral-950/70 px-3 py-1.5" data-testid="app-header">
        <div className="text-[11px] uppercase tracking-widest text-amber-400/80">NotNative</div>
        <SessionTabs engine={engine} directory={activeDirectory} />
        <span className={`ml-auto rounded-full px-2 py-0.5 text-[10px] ${connected ? 'bg-emerald-900/50 text-emerald-300' : 'bg-red-900/40 text-red-300'}`} data-testid="connection-pill">
          {connected ? 'connected' : 'reconnecting'}
        </span>
        <button
          type="button"
          className="rounded px-2 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          data-testid="diff-toggle"
          title="Changes"
          onClick={() => {
            setFilesOpen(false);
            setReviewPane(reviewPane === 'diff' ? '' : 'diff');
          }}
        >
          ⇆ diffs
        </button>
        <button
          type="button"
          className="rounded px-2 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          data-testid="git-toggle"
          title="Git"
          onClick={() => {
            setFilesOpen(false);
            setReviewPane(reviewPane === 'git' ? '' : 'git');
          }}
        >
          ⑂ git
        </button>
        <button
          type="button"
          className="rounded px-2 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          data-testid="files-toggle"
          title="Files"
          onClick={() => {
            setReviewPane('');
            setFilesOpen(!filesOpen);
          }}
        >
          ▤ files
        </button>
        <button
          type="button"
          className="rounded px-2 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          data-testid="settings-gear"
          title="Settings (Ctrl+Comma)"
          onClick={() => openSettings('general')}
        >
          ⚙ settings
        </button>
      </header>
      <div className="flex min-h-0 flex-1">
        {filesOpen ? (
          <FilesView directory={activeDirectory} visible />
        ) : reviewPane === 'diff' ? (
          <DiffView directory={activeDirectory} visible />
        ) : reviewPane === 'git' ? (
          <GitView directory={activeDirectory} />
        ) : (
          <>
            <ChatSidebar engine={engine} currentDirectory={activeDirectory} currentSessionId={view.currentSessionId} actions={actions} />
            <ChatView services={services} currentDirectory={activeDirectory} />
          </>
        )}
      </div>
      {settingsPage !== null ? (
        <SettingsWindow initialPage={settingsPage} onClose={closeSettings} />
      ) : null}
      <Toaster position="bottom-right" />
    </div>
  );
}

/** `?settings=<slug>` deep link (PWA manifest shortcut target). */
function slugFromLocation(): SettingsPageSlug | null {
  if (typeof window === 'undefined') return null;
  const raw = new URLSearchParams(window.location.search).get('settings');
  if (raw === null || raw.length === 0) return null;
  return (BUILT_PAGE_SLUGS as readonly string[]).includes(raw) ? (raw as SettingsPageSlug) : null;
}

function normalizeDirectoryInput(directory: string): string {
  return directory.replaceAll('\\', '/');
}

function globalHome(global: ReturnType<typeof useGlobalSyncStore.getState>): string {
  return typeof global.path?.['directory'] === 'string' ? String(global.path['directory']) : '';
}
