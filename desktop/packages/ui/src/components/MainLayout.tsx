// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { Toaster, toast } from 'sonner';
import { useI18n } from '../lib/i18n/context.tsx';
import { mountEngine } from '../chat/app-engine.ts';
import { ChatView } from '../chat/chat-view.tsx';
import { ChatSidebar } from '../chat/session-sidebar.tsx';
import { ArchiveView } from '../chat/archive-view.tsx';
import { SessionTabs } from '../chat/session-tabs.tsx';
import { normalizeDirectory } from '../lib/nnd/client.ts';
import { nnaOwnsPermissionReview } from '../lib/nnd/permission-policy.ts';
import { useSessionViewStore } from '../sync/view-store.ts';
import { persistLastActiveSession } from '../sync/persist-cache.ts';
import { defaultHarnessDirectory } from '../sync/engine-support.ts';
import { GLOBAL_DIRECTORY } from '../sync/routing-index.ts';
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
import { AgentManagerView } from './agent-groups/AgentManagerView.tsx';
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
import { runtimeFetch } from '../lib/runtime-fetch.ts';
import { type SettingsPageSlug } from './settings/search.ts';
import { bindSettingsBridge } from '../lib/settings/store.ts';
import { bindAppearanceAppliers } from '../lib/settings/apply.ts';
import { WorkspaceIdentity } from './workspace-identity.tsx';
import type { ComposerServices } from '../chat/composer.tsx';
import { readMiniChatLaunch } from '../lib/miniChatLaunch.ts';
import { useKeybind } from '../lib/shortcuts/hooks.ts';
import { CommandPalette, openCommandPalette } from '../chat/command-palette.tsx';
import { usePushPresence } from './push-presence.tsx';
import { mountSessionRoute, notifySessionRouteNavigation } from '../lib/session-route.ts';
import { useWorkspaceRoute } from './use-workspace-route.ts';

function subscribeRuntimeKey(notify: () => void): () => void {
  window.addEventListener('notnative:runtime-endpoint-changed', notify);
  return () => window.removeEventListener('notnative:runtime-endpoint-changed', notify);
}

/** MainLayout (doc 01 13.1) with the P3a chat product, the P5-6
 * SettingsWindow (gear / mod+, / ?settings=<slug>) and the P6-1 FilesView
 * (Files button; full surface with the tree over the chat column). */
export function MainLayout(): ReactNode {
  usePushPresence();
  const engine = mountEngine();
  const miniChat = readMiniChatLaunch(typeof window === 'undefined' ? '' : window.location.search).enabled;
  const { t } = useI18n();
  const runtimeKey = useSyncExternalStore(subscribeRuntimeKey, getRuntimeKey);
  const [nativeAlpha, setNativeAlpha] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setNativeAlpha(false);
    void runtimeFetch('/health', { signal: controller.signal }).then(async response => {
      if (!response.ok) return;
      const health = await response.json() as { runtime?: unknown };
      if (!controller.signal.aborted) setNativeAlpha(health.runtime === 'service');
    }).catch(() => {});
    return () => controller.abort();
  }, [runtimeKey]);
  useEffect(() => mountSessionRoute(() => toast.error('Could not open the linked session.')), [runtimeKey]);
  const view = useSyncExternalStore(useSessionViewStore.subscribe, useSessionViewStore.getState);
  const global = useSyncExternalStore(useGlobalSyncStore.subscribe, useGlobalSyncStore.getState);
  const terminalUnavailable = global.config === null || nnaOwnsPermissionReview(global.config);
  const connected = useSyncExternalStore(useConfigStore.subscribe, () => useConfigStore.getState().isConnected);
  const [filesOpen, setFilesOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [reviewPane, setReviewPane] = useState<'' | 'diff' | 'git' | 'plan' | 'terminal' | 'agent-groups'>('');
  const [worktreesOpen, setWorktreesOpen] = useState(false);
  const [harnessDirectory, setHarnessDirectory] = useState('');

  const showChat = useCallback(() => { setFilesOpen(false); setReviewPane(''); setArchiveOpen(false); }, []);
  const { settingsPage, closeSettings, openSettings } = useWorkspaceRoute(runtimeKey, showChat);
  const [scheduledOpen, setScheduledOpen] = useState(false);
  const [multiRunOpen, setMultiRunOpen] = useState(false);
  const [fusionTarget, setFusionTarget] = useState<{ trigger: Session; identity: NonNullable<ReturnType<typeof fusionIdentityFromSession>> } | null>(null);
  const openScheduled = useCallback(() => { if (!nativeAlpha) setScheduledOpen(true); }, [nativeAlpha]);
  const closeScheduled = useCallback(() => setScheduledOpen(false), []);
  const closeMultiRun = useCallback(() => setMultiRunOpen(false), []);
  const openFusion = useCallback((session: Session) => {
    if (nativeAlpha) return;
    const identity = fusionIdentityFromSession(session);
    if (identity === null) return;
    setFusionTarget({ trigger: session, identity });
  }, [nativeAlpha]);
  const closeFusion = useCallback(() => setFusionTarget(null), []);
  const openEditorFile = useCallback((directory: string, path: string) => {
    if (nativeAlpha) return;
    setReviewPane('');
    setFilesOpen(true);
    useFilesViewTabsStore.getState().setSelectedPath(directory, path, getRuntimeKey());
  }, [nativeAlpha]);
  useScheduledShellWiring(openScheduled, openEditorFile);

  useEffect(() => {
    if (!nativeAlpha) return;
    setFilesOpen(false); setReviewPane(''); setWorktreesOpen(false);
    setScheduledOpen(false); setMultiRunOpen(false); setFusionTarget(null);
  }, [nativeAlpha]);

  useEffect(() => {
    bindSettingsBridge();
    bindAppearanceAppliers();
  }, []);

  useEffect(() => {
    if (!miniChat) return;
    void window.__NOTNATIVE_DESKTOP_INVOKE__?.('desktop_get_current_window_state').then((reply) => {
      if (reply.ok && typeof reply.result === 'object' && reply.result !== null
        && typeof (reply.result as { pinned?: unknown }).pinned === 'boolean') {
        document.documentElement.dataset['miniChatPinned'] = String((reply.result as { pinned: boolean }).pinned);
      }
    });
  }, [miniChat]);

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
        toast.message(t('shell.toast.nothingSelected', { command }));
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
        if (lastUserIndex < 0) { toast.message(t('shell.toast.nothingToRevert')); return; }
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
          .catch(() => toast.error(t('shell.toast.revertFailed')));
        return;
      }
      if (command === 'redo') {
        void engine.actions.unrevert(sessionID)
          .then(() => engine.loader.refreshTail({ directory: live.activeDirectory, sessionID, store: engine.childStoreOf(live.activeDirectory) ?? engine.manager.ensureChild(live.activeDirectory) }, 50))
          .catch(() => toast.error(t('shell.toast.redoFailed')));
        return;
      }
      if (command === 'compact') toast.message(t('shell.toast.compactHarness'));
    },
  }));

  useEffect(() => {
    if (view.activeDirectory && view.activeDirectory !== GLOBAL_DIRECTORY) return;
    const path = global.path as Record<string, unknown> | null;
    const directory = typeof path?.['directory'] === 'string' ? String(path['directory']) : '';
    if (directory && directory !== GLOBAL_DIRECTORY) useSessionViewStore.getState().setActiveDirectory(directory);
  }, [global.path, view.activeDirectory]);

  // SLICE-B: review panes ride the ACTIVE HARNESS directory (doc engine-support
  // defaultHarnessDirectory) — never the literal '/'. Resolution stores the
  // directory once so boot-time panes see the real root.
  useEffect(() => {
    if (view.activeDirectory && view.activeDirectory !== GLOBAL_DIRECTORY || harnessDirectory !== '') return;
    void defaultHarnessDirectory().then((resolved) => {
      if (!resolved || resolved === GLOBAL_DIRECTORY) return;
      setHarnessDirectory(resolved);
      const current = useSessionViewStore.getState().activeDirectory;
      if (!current || current === GLOBAL_DIRECTORY) useSessionViewStore.getState().setActiveDirectory(resolved);
    }).catch(() => undefined);
  }, [view.activeDirectory, harnessDirectory]);

  const actions = {
    openDraft: (directory: string) => {
      persistLastActiveSession(null, directory); // draft intent clears the pointer
      useSessionViewStore.setState({ currentSessionId: null, activeDirectory: directory });
      notifySessionRouteNavigation();
    },
    openSession: (sessionID: string, directory: string) => {
      // F.4: navigation NEVER denies pending requests — dismiss is authority
      // of the send path and the explicit card buttons only.
      persistLastActiveSession(sessionID, directory); // remember for next boot
      useSessionViewStore.setState({ currentSessionId: sessionID, activeDirectory: directory });
      notifySessionRouteNavigation();
      setArchiveOpen(false);
    },
    rename: (sessionID: string, title: string): Promise<void> => {
      const trimmed = title.trim();
      if (!trimmed) {
        toast.message(t('shell.toast.titleEmpty'));
        return Promise.resolve();
      }
      return engine.actions.rename(sessionID, trimmed)
        .then(() => { toast.success(t('shell.toast.renamed')); })
        .catch(() => { toast.error(t('shell.toast.renameFailed')); });
    },
    // engine.actions already gate on fresh authority — alias the pass-throughs.
    archive: engine.actions.archive,
    restore: engine.actions.restore,
    deleteSession: engine.actions.deleteSession,
  } as const;

  useEffect(() => window.__NOTNATIVE_DESKTOP_EVENTS__?.onOpenSession(({ sessionId, directory }) => {
    actions.openSession(sessionId, directory ?? useSessionViewStore.getState().activeDirectory);
  }), []);

  const activeDirectory = normalizeDirectoryInput((view.activeDirectory === GLOBAL_DIRECTORY ? '' : view.activeDirectory)
    || globalHome(global) || harnessDirectory);
  const openMiniChat = (): void => {
    const invoke = window.__NOTNATIVE_DESKTOP_INVOKE__;
    if (!invoke) return;
    const mode = view.currentSessionId ? 'session' : 'draft';
    void invoke('desktop_open_mini_chat', {
      mode,
      ...(mode === 'session' ? { sessionId: view.currentSessionId } : {}),
      directory: activeDirectory,
    });
  };
  useKeybind('new_mini_chat', openMiniChat);
  useKeybind('open_command_palette', () => { if (!miniChat) openCommandPalette(); });
  const closeMiniChat = (): void => { void window.__NOTNATIVE_DESKTOP_INVOKE__?.('desktop_close_current_window'); };
  const togglePinned = async (): Promise<void> => {
    const invoke = window.__NOTNATIVE_DESKTOP_INVOKE__;
    if (!invoke) return;
    const current = document.documentElement.dataset['miniChatPinned'] === 'true';
    const result = await invoke('desktop_set_window_pinned', { pinned: !current });
    if (result.ok) document.documentElement.dataset['miniChatPinned'] = String(!current);
  };

  return (
    <div className={`flex h-screen flex-col flex-1 bg-neutral-900 text-neutral-100${miniChat ? ' nnd-mini-chat' : ''}`} data-testid={miniChat ? 'mini-chat-layout' : undefined}>
      {!miniChat && !terminalUnavailable ? <TerminalKeepaliveOwner /> : null}
      {!miniChat ? <ShellShortcuts /> : null}
      {miniChat ? (
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-white/10 bg-neutral-950/80 px-3" data-testid="mini-chat-header" style={{ WebkitAppRegion: 'drag' } as CSSProperties & { WebkitAppRegion: string }}>
          <span className="text-xs font-medium text-neutral-200">NotNative Mini Chat</span>
          <span className="ml-auto" />
          <button type="button" aria-label={t('shell.minichat.pinAria')} title={t('shell.minichat.pin')} className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800" style={{ WebkitAppRegion: 'no-drag' } as CSSProperties & { WebkitAppRegion: string }} onClick={() => { void togglePinned(); }}>⌖</button>
          <button type="button" aria-label={t('shell.minichat.closeAria')} title={t('shell.minichat.close')} className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800" style={{ WebkitAppRegion: 'no-drag' } as CSSProperties & { WebkitAppRegion: string }} onClick={closeMiniChat}>×</button>
        </header>
      ) : (
      <header className="flex min-w-0 items-center gap-2 border-b border-white/10 bg-neutral-950/70 px-3 py-1.5" data-testid="app-header">
        <div className="text-[11px] uppercase tracking-widest text-amber-400/80">NotNative</div>
        <WorkspaceIdentity directory={activeDirectory} engine={engine} runtimeKey={runtimeKey} onOpenDraft={actions.openDraft} />
        <SessionTabs engine={engine} directory={activeDirectory} />
        <button type="button" data-testid="mini-chat-open" title={t('shell.minichat.openAria')} aria-label={t('shell.minichat.openAria')}
          className="rounded px-2 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100" onClick={openMiniChat}>▣</button>
        <span className={`ml-auto rounded-full px-2 py-0.5 text-[10px] ${connected ? 'bg-emerald-900/50 text-emerald-300' : 'bg-red-900/40 text-red-300'}`} data-testid="connection-pill">
          {connected ? t('shell.status.connected') : t('shell.status.reconnecting')}
        </span>
        <button
          type="button"
          className="rounded px-2 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          data-testid="diff-toggle"
          title={t('shell.nav.changes')}
          aria-label={t('shell.nav.changes')}
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
          title={nativeAlpha ? 'Git actions are unavailable in the native alpha' : t('shell.nav.git')}
          aria-label={t('shell.nav.git')}
          disabled={nativeAlpha}
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
          title={nativeAlpha ? 'Plans are unavailable in the native alpha' : t('shell.nav.plan')}
          aria-label={t('shell.nav.plan')}
          disabled={nativeAlpha}
          onClick={() => {
            setFilesOpen(false);
            setReviewPane(reviewPane === 'plan' ? '' : 'plan');
          }}
        >
          ▤
        </button>
        <button
          type="button"
          className="rounded px-2 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 disabled:opacity-40"
          data-testid="terminal-toggle"
          title={terminalUnavailable ? 'Terminal is unavailable for native sessions' : t('terminal.title')}
          aria-label={t('terminal.title')}
          disabled={terminalUnavailable}
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
          title={nativeAlpha ? 'Scheduled tasks are unavailable in the native alpha' : t('shell.nav.scheduledTasks')}
          aria-label={t('shell.nav.scheduledTasks')}
          disabled={nativeAlpha}
          onClick={openScheduled}
        >
          ◷
        </button>
        <button
          type="button"
          className="rounded px-2 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          data-testid="agent-groups-toggle"
          title={nativeAlpha ? 'Agent groups are unavailable in the native alpha' : t('shell.nav.agentGroups')}
          aria-label={t('shell.nav.agentGroups')}
          disabled={nativeAlpha}
          onClick={() => {
            setFilesOpen(false);
            setReviewPane(reviewPane === 'agent-groups' ? '' : 'agent-groups');
          }}
        >
          ▦
        </button>
        <button
          type="button"
          className="rounded px-2 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          data-testid="worktrees-toggle"
          title={nativeAlpha ? 'Worktrees are unavailable in the native alpha' : t('shell.nav.worktrees')}
          aria-label={t('shell.nav.worktrees')}
          disabled={nativeAlpha}
          onClick={() => setWorktreesOpen(!worktreesOpen)}
        >
          ⌥
        </button>
        <button
          type="button"
          className="rounded px-2 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          data-testid="multirun-toggle"
          title={nativeAlpha ? 'Multi-run is unavailable in the native alpha' : t('shell.nav.multiRun')}
          aria-label={t('shell.nav.multiRun')}
          disabled={nativeAlpha}
          onClick={() => setMultiRunOpen(true)}
        >
          ⧉
        </button>
        <button
          type="button"
          className="rounded px-2 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          data-testid="files-toggle"
          title={nativeAlpha ? 'File editing is unavailable in the native alpha' : t('shell.nav.files')}
          aria-label={t('shell.nav.files')}
          disabled={nativeAlpha}
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
          title={t('shell.nav.settingsShortcut')}
          aria-label={t('shell.nav.settings')}
          onClick={() => openSettings('general')}
        >
          ⚙
        </button>
      </header>
      )}
      <AuthExpiredBanner />
      {nativeAlpha ? <div role="status" data-testid="native-alpha-notice" className="border-b border-amber-800/50 bg-amber-950/30 px-3 py-1 text-xs text-amber-200">
        Native alpha: chat and NNA review are available. File, Git, queue, and other workspace actions are waiting for native review support.
      </div> : null}
      <div className={`flex min-h-0 flex-1${miniChat ? ' overflow-hidden' : ''}`}>
        {miniChat ? <ChatView services={services} currentDirectory={activeDirectory} /> : null}
        {!miniChat ? (filesOpen ? (
          <FilesView key={JSON.stringify([runtimeKey, activeDirectory])} directory={activeDirectory} visible />
        ) : reviewPane === 'diff' ? (
          <DiffView directory={activeDirectory} visible />
        ) : reviewPane === 'git' ? (
          <GitView directory={activeDirectory} draftScope={commitDraftScope(runtimeKey, activeDirectory)} />
        ) : reviewPane === 'plan' ? (
          <PlanView directory={activeDirectory} visible />
        ) : reviewPane === 'terminal' ? (
          terminalUnavailable
            ? <div role="status" className="p-4 text-sm text-neutral-400">Terminal is unavailable for native sessions.</div>
            : <TerminalView directory={activeDirectory} visible />
        ) : reviewPane === 'agent-groups' ? (
          <AgentManagerView
            projectRoot={activeDirectory}
            currentDirectory={activeDirectory}
            onClose={() => setReviewPane('')}
            onOpenSession={(session) => actions.openSession(session.id, session.directory ?? '')}
            services={services}
          />
        ) : archiveOpen ? (
          <ArchiveView currentDirectory={activeDirectory} onClose={() => setArchiveOpen(false)}
            onOpenSession={actions.openSession} onRestore={actions.restore} onDelete={actions.deleteSession} />
        ) : (
          <>
            <ChatSidebar engine={engine} currentDirectory={activeDirectory} currentSessionId={view.currentSessionId} actions={actions} onOpenArchive={() => setArchiveOpen(true)} onRunFusion={nativeAlpha ? undefined : openFusion} />
            <ChatView services={services} currentDirectory={activeDirectory} />
          </>
        )) : null}
      </div>
      {settingsPage !== null ? (
        <SettingsWindow initialPage={settingsPage} onPageChange={openSettings} onClose={closeSettings} nativeAlpha={nativeAlpha} />
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
      {!miniChat ? <CommandPalette actions={actions} currentDirectory={activeDirectory}
        onOpenArchive={() => setArchiveOpen(true)} onOpenSettings={() => window.dispatchEvent(new Event(settingsOpenEventName))} /> : null}
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
