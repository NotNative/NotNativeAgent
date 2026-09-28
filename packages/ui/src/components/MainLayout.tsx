// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Toaster, toast } from 'sonner';
import { useI18n } from '../lib/i18n/context.tsx';
import { mountEngine } from '../chat/app-engine.ts';
import { ChatView } from '../chat/chat-view.tsx';
import { ChatSidebar } from '../chat/session-sidebar.tsx';
import { ArchiveView } from '../chat/archive-view.tsx';
import { SessionTabs } from '../chat/session-tabs.tsx';
import { normalizeDirectory } from '../lib/nnd/client.ts';
import { useSessionViewStore } from '../sync/view-store.ts';
import { persistLastActiveSession } from '../sync/persist-cache.ts';
import { defaultHarnessDirectory } from '../sync/engine-support.ts';
import { useGlobalSyncStore } from '../sync/global-stores.ts';
import { useConfigStore } from '../stores/useConfigStore.ts';
import { ShellShortcuts, settingsOpenEventName } from './ShellShortcuts.tsx';
import { AuthExpiredBanner } from './auth/AuthExpiredBanner.tsx';
import { SettingsWindow } from './settings/window.tsx';
import { FilesView } from './files/FilesView.tsx';
import { DiffView } from './diff/DiffView.tsx';
import { GitView } from './git/GitView.tsx';
import { commitDraftScope } from '../lib/git/commit-drafts.ts';
import { PlanView } from './plan/PlanView.tsx';
import { WorktreesView } from './worktrees/WorktreesView.tsx';
import { TerminalView } from './terminal/TerminalView.tsx';
import { TerminalKeepaliveOwner } from './terminal/TerminalKeepaliveOwner.tsx';
import { ScheduledTasksDialog } from './scheduled/scheduled-tasks-dialog.tsx';
import { launchedSessionDirectory, MultiRunLauncher } from '../chat/multirun-launcher.tsx';
import { MultiRunFusionDialog } from '../chat/multirun-fusion-dialog.tsx';
import { fusionIdentityFromSession } from '../lib/multirun/fusion.ts';
import type { Session } from '../lib/nnd/types.ts';
import { useScheduledShellWiring } from './scheduled/scheduled-shell-wiring.tsx';
import { useFilesViewTabsStore } from '../lib/files/tabs-store.ts';
import { getRuntimeKey } from '../lib/runtime-switch.ts';
import { BUILT_PAGE_SLUGS, type SettingsPageSlug } from './settings/search.ts';
import { bindSettingsBridge } from '../lib/settings/store.ts';
import { bindAppearanceAppliers } from '../lib/settings/apply.ts';
import { WorkspaceIdentity } from './workspace-identity.tsx';
import type { ComposerServices } from '../chat/composer.tsx';

function subscribeRuntimeKey(notify: () => void): () => void {
  window.addEventListener('notnative:runtime-endpoint-changed', notify);
  return () => window.removeEventListener('notnative:runtime-endpoint-changed', notify);
}

/** MainLayout (doc 01 13.1) with the P3a chat product, the P5-6
 * SettingsWindow (gear / mod+, / ?settings=<slug>) and the P6-1 FilesView
 * (Files button; full surface with the tree over the chat column). */
export function MainLayout(): ReactNode {
  const engine = mountEngine();
  const { t } = useI18n();
  const runtimeKey = useSyncExternalStore(subscribeRuntimeKey, getRuntimeKey);
  const view = useSyncExternalStore(useSessionViewStore.subscribe, useSessionViewStore.getState);
  const global = useSyncExternalStore(useGlobalSyncStore.subscribe, useGlobalSyncStore.getState);
  const connected = useSyncExternalStore(useConfigStore.subscribe, () => useConfigStore.getState().isConnected);
  const [settingsPage, setSettingsPage] = useState<SettingsPageSlug | null>(() => slugFromLocation());
  const [filesOpen, setFilesOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [reviewPane, setReviewPane] = useState<'' | 'diff' | 'git' | 'plan' | 'terminal'>('');
  const [worktreesOpen, setWorktreesOpen] = useState(false);
  const [harnessDirectory, setHarnessDirectory] = useState('');

  const closeSettings = useCallback(() => setSettingsPage(null), []);
  const openSettings = useCallback((slug: SettingsPageSlug) => setSettingsPage(slug), []);
  const [scheduledOpen, setScheduledOpen] = useState(false);
  const [multiRunOpen, setMultiRunOpen] = useState(false);
  const [fusionTarget, setFusionTarget] = useState<{ trigger: Session; identity: NonNullable<ReturnType<typeof fusionIdentityFromSession>> } | null>(null);
  const openScheduled = useCallback(() => setScheduledOpen(true), []);
  const closeScheduled = useCallback(() => setScheduledOpen(false), []);
  const closeMultiRun = useCallback(() => setMultiRunOpen(false), []);
  const openFusion = useCallback((session: Session) => {
    const identity = fusionIdentityFromSession(session);
    if (identity === null) return;
    setFusionTarget({ trigger: session, identity });
  }, []);
  const closeFusion = useCallback(() => setFusionTarget(null), []);
  const openEditorFile = useCallback((directory: string, path: string) => {
    setReviewPane('');
    setFilesOpen(true);
    useFilesViewTabsStore.getState().setSelectedPath(directory, path, getRuntimeKey());
  }, []);
  useScheduledShellWiring(openScheduled, openEditorFile);

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
    store: (requestedDirectory) => {
      const current = requestedDirectory || useSessionViewStore.getState().activeDirectory || '/';
      return engine.childStoreOf(current) ?? engine.manager.ensureChild(current);
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
        // D.6 keep-point semantics: revert TO the last user message. The
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
    if (view.activeDirectory) return;
    const path = global.path as Record<string, unknown> | null;
    const directory = typeof path?.['directory'] === 'string' ? String(path['directory']) : '';
    if (directory) useSessionViewStore.getState().setActiveDirectory(directory);
  }, [global.path, view.activeDirectory]);

  // SLICE-B: review panes ride the ACTIVE HARNESS directory (doc engine-support
  // defaultHarnessDirectory) — never the literal '/'. Resolution stores the
  // directory once so boot-time panes see the real root.
  useEffect(() => {
    if (view.activeDirectory || harnessDirectory !== '') return;
    void defaultHarnessDirectory().then((resolved) => {
      if (!resolved) return;
      setHarnessDirectory(resolved);
      if (!useSessionViewStore.getState().activeDirectory) {
        useSessionViewStore.getState().setActiveDirectory(resolved);
      }
    }).catch(() => undefined);
  }, [view.activeDirectory, harnessDirectory]);

  const actions = {
    openDraft: (directory: string) => {
      persistLastActiveSession(null, directory); // draft intent clears the pointer
      useSessionViewStore.setState({ currentSessionId: null, activeDirectory: directory });
    },
    openSession: (sessionID: string, directory: string) => {
      // F.4: navigation NEVER denies pending requests — dismiss is authority
      // of the send path and the explicit card buttons only.
      persistLastActiveSession(sessionID, directory); // remember for next boot
      useSessionViewStore.setState({ currentSessionId: sessionID, activeDirectory: directory });
      setArchiveOpen(false);
    },
    rename: (sessionID: string, title: string): Promise<void> => {
      const trimmed = title.trim();
      if (!trimmed) {
        toast.message('Title unchanged — empty name');
        return Promise.resolve();
      }
      return engine.actions.rename(sessionID, trimmed)
        .then(() => { toast.success('Session renamed'); })
        .catch(() => { toast.error('Failed to rename the session'); });
    },
    archive: async (sessionID: string, directory: string) => {
      await engine.actions.archive(sessionID, directory);
    },
    restore: async (sessionID: string, directory: string) => {
      await engine.actions.restore(sessionID, directory);
    },
    deleteSession: async (sessionID: string, directory: string) => {
      await engine.actions.deleteSession(sessionID, directory);
    },
  } as const;

  const activeDirectory = normalizeDirectoryInput(view.activeDirectory || globalHome(global) || harnessDirectory);

  return (
    <div className="flex h-screen flex-col flex-1 bg-neutral-900 text-neutral-100">
      <TerminalKeepaliveOwner />
      <ShellShortcuts />
      <header className="flex min-w-0 items-center gap-2 border-b border-white/10 bg-neutral-950/70 px-3 py-1.5" data-testid="app-header">
        <div className="text-[11px] uppercase tracking-widest text-amber-400/80">NotNative</div>
        <WorkspaceIdentity directory={activeDirectory} engine={engine} runtimeKey={runtimeKey} />
        <SessionTabs engine={engine} directory={activeDirectory} />
        <span className={`ml-auto rounded-full px-2 py-0.5 text-[10px] ${connected ? 'bg-emerald-900/50 text-emerald-300' : 'bg-red-900/40 text-red-300'}`} data-testid="connection-pill">
          {connected ? 'connected' : 'reconnecting'}
        </span>
        <button
          type="button"
          className="rounded px-2 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          data-testid="diff-toggle"
          title="Changes"
          aria-label="Changes"
          onClick={() => {
            setFilesOpen(false);
            setReviewPane(reviewPane === 'diff' ? '' : 'diff');
          }}
        >
          ⇆
        </button>
        <button
          type="button"
          className="rounded px-2 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          data-testid="git-toggle"
          title="Git"
          aria-label="Git"
          onClick={() => {
            setFilesOpen(false);
            setReviewPane(reviewPane === 'git' ? '' : 'git');
          }}
        >
          ⑂
        </button>
        <button
          type="button"
          className="rounded px-2 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          data-testid="plan-toggle"
          title="Plan"
          aria-label="Plan"
          onClick={() => {
            setFilesOpen(false);
            setReviewPane(reviewPane === 'plan' ? '' : 'plan');
          }}
        >
          ▤
        </button>
        <button
          type="button"
          className="rounded px-2 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          data-testid="terminal-toggle"
          title={t('terminal.title')}
          aria-label={t('terminal.title')}
          onClick={() => {
            setFilesOpen(false);
            setReviewPane(reviewPane === 'terminal' ? '' : 'terminal');
          }}
        >
          &gt;_
        </button>
        <button
          type="button"
          className="rounded px-2 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          data-testid="scheduled-tasks-toggle"
          title="Scheduled tasks"
          aria-label="Scheduled tasks"
          onClick={openScheduled}
        >
          ◷
        </button>
        <button
          type="button"
          className="rounded px-2 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          data-testid="worktrees-toggle"
          title="Worktrees"
          aria-label="Worktrees"
          onClick={() => setWorktreesOpen(!worktreesOpen)}
        >
          ⌥
        </button>
        <button
          type="button"
          className="rounded px-2 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          data-testid="multirun-toggle"
          title="Multi-run"
          aria-label="Multi-run"
          onClick={() => setMultiRunOpen(true)}
        >
          ⧉
        </button>
        <button
          type="button"
          className="rounded px-2 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          data-testid="files-toggle"
          title="Files"
          aria-label="Files"
          onClick={() => {
            setReviewPane('');
            setFilesOpen(!filesOpen);
          }}
        >
          <svg aria-hidden="true" className="inline-block align-middle" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M3 9h18" /></svg>
        </button>
        <button
          type="button"
          className="rounded px-2 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          data-testid="settings-gear"
          title="Settings (Ctrl+Comma)"
          aria-label="Settings"
          onClick={() => openSettings('general')}
        >
          ⚙
        </button>
      </header>
      <AuthExpiredBanner />
      <div className="flex min-h-0 flex-1">
        {filesOpen ? (
          <FilesView key={JSON.stringify([runtimeKey, activeDirectory])} directory={activeDirectory} visible />
        ) : reviewPane === 'diff' ? (
          <DiffView directory={activeDirectory} visible />
        ) : reviewPane === 'git' ? (
          <GitView directory={activeDirectory} draftScope={commitDraftScope(runtimeKey, activeDirectory)} />
        ) : reviewPane === 'plan' ? (
          <PlanView directory={activeDirectory} visible />
        ) : reviewPane === 'terminal' ? (
          <TerminalView directory={activeDirectory} visible />
        ) : archiveOpen ? (
          <ArchiveView currentDirectory={activeDirectory} onClose={() => setArchiveOpen(false)}
            onOpenSession={actions.openSession} onRestore={actions.restore} onDelete={actions.deleteSession} />
        ) : (
          <>
            <ChatSidebar engine={engine} currentDirectory={activeDirectory} currentSessionId={view.currentSessionId} actions={actions} onOpenArchive={() => setArchiveOpen(true)} onRunFusion={openFusion} />
            <ChatView services={services} currentDirectory={activeDirectory} />
          </>
        )}
      </div>
      {settingsPage !== null ? (
        <SettingsWindow initialPage={settingsPage} onClose={closeSettings} />
      ) : null}
      {worktreesOpen ? (
        <WorktreesView projectRoot={activeDirectory} onClose={() => setWorktreesOpen(false)} />
      ) : null}
      {scheduledOpen ? (
        <ScheduledTasksDialog directory={activeDirectory} onClose={closeScheduled} services={services} />
      ) : null}
      {multiRunOpen ? (
        <MultiRunLauncher directory={activeDirectory} services={services} onClose={closeMultiRun}
          onLaunched={(result, directory) => {
            const firstSessionDirectory = launchedSessionDirectory(engine, result, directory);
            if (result.firstSessionId === null || firstSessionDirectory === null) return;
            actions.openSession(result.firstSessionId, firstSessionDirectory);
          }} />
      ) : null}
      {fusionTarget ? (
        <MultiRunFusionDialog
          services={services}
          trigger={fusionTarget.trigger}
          identity={fusionTarget.identity}
          onClose={closeFusion}
          onLaunched={() => setFusionTarget(null)}
        />
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
