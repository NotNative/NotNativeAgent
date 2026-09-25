// SPDX-License-Identifier: Apache-2.0
/**
 * TerminalView (doc 07 sections 6.3-6.5, v1 with the E-07-1 line-buffer
 * renderer registered in NOTES/07): per-directory tab strip + one live
 * viewport; create at provisional 80x24 with sessionId = tabId and
 * single-flight per (directory, tab) ONLY from the seeded idle placeholder
 * (a failed create or a demoted exited tab is retried by user action, never
 * auto-spammed); the transport subscribes the ACTIVE tab's session
 * (hidden tabs keep buffers); snapshot REPLACES the buffer at the recorded
 * PTY size; outputs append (replay-safe `r` when present); exit appends the
 * localized line; quick keys per section 6.4 (v1 input line + fixed chords);
 * Restart (interactive only); Kill rides the force-kill endpoint (immediate
 * SIGKILL per section 3.7). Attach selection rides Flow 5 into the P6
 * inline-comment draft store (source 'terminal') and refocuses the composer.
 * Project-action orchestration + URL preview are registered to doc 12/13.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  closeTerminalSession, createTerminalSession, forceKillTerminals, restartTerminalSession, resizeTerminalSession,
} from '../../lib/server-api.ts';
import { observeTerminalSessions } from '../../lib/terminal/observer.ts';
import {
  appendTerminalBuffer, dropTerminalBuffer, getTerminalBuffer, normalizeTerminalDirectory,
  replaceTerminalBuffer, useTerminalStore, type TerminalTab,
} from '../../lib/terminal/store.ts';
import { getTerminalTransport } from '../../lib/terminal/transport-singleton.ts';
import type { TerminalEventFrame } from '../../lib/terminal/wire.ts';
import { translate } from '../../lib/i18n/store.ts';
import { useI18n } from '../I18nProvider.tsx';
import { useInlineCommentDrafts } from '../../lib/comments/drafts.ts';
import { useActiveSessionKey } from '../comments/useActiveSessionKey.ts';
import { FOCUS_EVENT_NAME } from '../comments/focus-chat.ts';

const PROVISIONAL_SIZE = { cols: 80, rows: 24 };
const EMPTY_TABS: TerminalTab[] = [];

export interface TerminalViewProps { directory: string; visible: boolean; compact?: boolean }

export function TerminalView({ directory, visible, compact = false }: TerminalViewProps): ReactNode {
  const key = normalizeTerminalDirectory(directory);
  const tabs = useTerminalStore((state) => state.dirs[key]?.tabs ?? EMPTY_TABS);
  const activeTabId = useTerminalStore((state) => state.dirs[key]?.activeTabId ?? '');
  const active = tabs.find((tab) => tab.id === activeTabId) ?? null;
  useTerminalBootstrap(directory);
  useTerminalObserver(directory, key, visible);
  useTerminalCreate(directory, visible, active);
  useTerminalStream(directory, key, active, visible);
  if (active === null) return null;
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col gap-1 rounded-lg border border-border/60 bg-card/40 px-2 pb-2 pt-1" data-testid="terminal-view">
      <TabStrip tabs={tabs} activeTabId={activeTabId} directory={directory} />
      <div className="min-h-0 flex-1 overflow-auto rounded border border-border/40 bg-background/80 p-2 font-mono text-xs text-foreground" data-testid="terminal-buffer">
        <pre data-testid="terminal-text" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{viewText(key, active)}</pre>
      </div>
      <QuickKeys directory={directory} tab={active} compact={compact} />
    </div>
  );
}

function useTerminalBootstrap(directory: string): void {
  useEffect(() => {
    useTerminalStore.getState().hydrate();
    useTerminalStore.getState().ensureDirectory(directory);
    return undefined;
  }, [directory]);
}

function useTerminalObserver(directory: string, key: string, visible: boolean): void {
  useEffect(() => {
    if (!visible) return undefined;
    return observeTerminalSessions(directory, (sessions) => {
      useTerminalStore.getState().reconcileServerSessions(key, sessions.filter((session) => sameDir(session.cwd, directory)));
    });
  }, [directory, key, visible]);
}

/** section F1 step 5: spawn for a seeded idle tab; the flight is per tab
 * (Set) so a fast tab switch cannot double-create. A failed create marked
 * exited is NEVER re-created automatically (the app-wide failed-create
 * loop): the user retries via the + tab button. */
function useTerminalCreate(directory: string, visible: boolean, active: TerminalTab | null): void {
  const flights = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!visible || active === null) return undefined;
    if (active.terminalSessionId !== null || active.lifecycle !== 'idle') return undefined;
    if (flights.current.has(active.id)) return undefined;
    flights.current.add(active.id);
    patchTabLifecycle(directory, active.id, 'starting');
    void createTerminalSession({ cwd: directory, sessionId: active.id, ...PROVISIONAL_SIZE, themeMode: 'dark' })
    .then(async (created) => {
      if (!created.ok) patchTabLifecycle(directory, active.id, 'exited');
      else if (terminalTabStillExists(directory, active.id)) {
        useTerminalStore.getState().setTabSession(directory, active.id, created.sessionId, 'running');
      } else {
        // Closing a tab while its create request is in flight otherwise leaves
        // an unlisted server PTY.  The local tab is gone, so release the just
        // created session instead of letting it survive until the reaper.
        await closeTerminalSession(created.sessionId).catch(() => undefined);
      }
      })
      .finally(() => { flights.current.delete(active.id); });
    return undefined;
  }, [active, directory, visible]);
}

function terminalTabStillExists(directory: string, tabId: string): boolean {
  const key = normalizeTerminalDirectory(directory);
  return useTerminalStore.getState().dirs[key]?.tabs.some((tab) => tab.id === tabId) === true;
}

/** One stream subscription at a time: the ACTIVE tab's session only
 * (hidden tabs keep buffers, section 6.5). */
function useTerminalStream(directory: string, key: string, active: TerminalTab | null, visible: boolean): void {
  const tabId = active?.id ?? '';
  const sessionId = active?.terminalSessionId ?? '';
  useTerminalStore((state) => state.bufferVersions[`${key}\u0000${tabId}`] ?? 0); // view redraw tick (E-07-13)
  useEffect(() => {
    if (!visible || tabId.length === 0 || sessionId.length === 0) return undefined;
    return subscribeTabStream(directory, key, tabId, sessionId);
  }, [directory, key, tabId, sessionId, visible]);
}

function patchTabLifecycle(directory: string, tabId: string, lifecycle: TerminalTab['lifecycle']): void {
  useTerminalStore.getState().patchTab(directory, tabId, { lifecycle });
}

function sameDir(left: string, right: string): boolean {
  return normalizeTerminalDirectory(left) === normalizeTerminalDirectory(right);
}

function viewText(key: string, tab: TerminalTab): string {
  const buffer = getTerminalBuffer(key, tab.id);
  if (buffer.text.length === 0) return '';
  return buffer.text.replace(/\r\n/gu, '\n'); // \r-overwrite emulation lands with the renderer swap (E-07-1)
}

function subscribeTabStream(directory: string, key: string, tabId: string, sessionId: string): () => void {
  const transport = getTerminalTransport();
  return transport.subscribe(sessionId, {
    onEvent: (event) => {
      const live = useTerminalStore.getState();
      if (event.t === 'snapshot') {
        replaceTerminalBuffer(directory, tabId, event.history, event.q, { cols: event.cols, rows: event.rows });
        void resizeTerminalSession(sessionId, event.cols, event.rows); // E-07-2: records the accepted size; fitted grid lands with E20
      } else if (event.t === 'output') {
        appendTerminalBuffer(directory, tabId, event.r ?? event.d, event.q);
      } else if (event.t === 'restarted') {
        replaceTerminalBuffer(directory, tabId, '', event.q, null);
      } else if (event.t === 'exit') {
        appendTerminalBuffer(directory, tabId, `\n[${exitedLine(event)}]\n`, event.q);
        live.patchTab(key, tabId, { lifecycle: 'exited', purposeExecutionId: null });
      } else if (event.t === 'error' && (event.fatal === true || event.code === 'SESSION_NOT_FOUND')) {
        dropTerminalBuffer(directory, tabId);
        live.patchTab(key, tabId, { lifecycle: 'exited', terminalSessionId: null });
      } else if (event.t === 'reconnecting') {
        return; // non-fatal state banner suppressed in v1 (section 6.3)
      }
    },
  });
}

function exitedLine(event: Extract<TerminalEventFrame, { t: 'exit' }>): string {
  if (event.exitCode === undefined) return translate('terminal.exited');
  return translate('terminal.exitedCode', { code: event.exitCode });
}

interface TabStripProps {
  tabs: TerminalTab[];
  activeTabId: string;
  directory: string;
}

function TabStrip({ tabs, activeTabId, directory }: TabStripProps): ReactNode {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-1 overflow-x-auto border-b border-border/40 pb-1" data-testid="terminal-tabs">
      {tabs.map((tab) => (
        <span key={tab.id} className={tab.id === activeTabId ? 'inline-flex items-center gap-1 rounded bg-interactive-selection/40 px-2 py-0.5 text-[11px]' : 'inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground'} data-testid="terminal-tab">
          <button type="button" onClick={() => useTerminalStore.getState().setActiveTab(directory, tab.id)}>{tab.label}</button>
          {tab.terminalSessionId !== null && tab.lifecycle === 'running' ? (
            <button type="button" aria-label={`${t('terminal.restart')} ${tab.label}`} data-testid={`terminal-tab-restart-${tab.id}`} onClick={() => void restartActiveTab(directory, tab)}>{t('terminal.restartGlyph')}</button>
          ) : null}
          <button type="button" aria-label={`${t('terminal.closeTab')} ${tab.label}`} data-testid={`terminal-tab-close-${tab.id}`} onClick={() => void closeTabGuarded(directory, tab.id)}>{t('terminal.closeGlyph')}</button>
        </span>
      ))}
      <button type="button" className="rounded px-1.5 text-muted-foreground hover:text-foreground" aria-label={t('terminal.newTab')} data-testid="terminal-new-tab" onClick={() => useTerminalStore.getState().addTab(directory)}>{t('terminal.newTab')}</button>
      <span className="sr-only">{t('terminal.title')}</span>
    </div>
  );
}

async function closeTabGuarded(directory: string, tabId: string): Promise<void> {
  try {
    await useTerminalStore.getState().closeTab(directory, tabId);
  } catch {
    toast.error(translate('terminal.closeFailed'));
  }
}

async function restartActiveTab(directory: string, tab: TerminalTab): Promise<void> {
  if (tab.terminalSessionId === null) return;
  const store = useTerminalStore.getState();
  store.patchTab(directory, tab.id, { lifecycle: 'stopping' });
  try {
    const restarted = await restartTerminalSession(tab.terminalSessionId, { cwd: directory });
    if (!restarted) {
      toast.error(translate('terminal.restartFailed')); // refused (400): the session still exists, stays live
    }
    store.patchTab(directory, tab.id, { lifecycle: 'running' }); // the stream keeps flowing; exit/fatal events correct the tab
  } catch {
    store.patchTab(directory, tab.id, { lifecycle: 'running' }); // network loss: the PTY likely still runs; never drop the tab's session
  }
}

interface QuickKeysProps { directory: string; tab: TerminalTab; compact: boolean }

function QuickKeys({ directory, tab, compact }: QuickKeysProps): ReactNode {
  const { t } = useI18n();
  const [line, setLine] = useState('');
  const sessionId = tab.terminalSessionId;
  const writable = sessionId !== null && tab.lifecycle === 'running';
  const send = useCallback((data: string, clearsLine?: boolean): void => {
    if (!writable || sessionId === null) return;
    try {
      getTerminalTransport().write(sessionId, data);
    } catch {
      toast.error(translate('terminal.sendFailed'));
      return;
    }
    if (clearsLine === true) setLine('');
  }, [sessionId, writable]);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const text = line;
    if (text.length === 0) return;
    setLine('');
    send(`${text}\r`); // section 6.4: Enter sends CR; the shell echo path is the only truth
  };
  return (
    <div className={`flex items-center gap-1 ${compact ? 'flex-wrap' : ''}`} data-testid="terminal-quick-keys">
      <input
        className={`min-w-0 flex-1 rounded border border-border/40 bg-transparent px-2 py-1 font-mono text-xs text-foreground outline-none ${compact ? 'basis-full' : ''}`}
        value={line}
        data-testid="terminal-input"
        onChange={(event) => setLine(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t('terminal.inputPlaceholder')}
        disabled={!writable}
      />
      {QUICK_KEYS.map((quickKey) => (
        <QuickKey key={quickKey.key} label={t(quickKey.key)} sequence={quickKey.sequence} clearsLine={quickKey.clearsLine} send={send} disabled={!writable} />
      ))}
      <AttachSelectionButton directory={directory} tab={tab} />
      {sessionId !== null ? (
        <button type="button" className="rounded border border-border/50 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-status-error" data-testid="terminal-kill-session" onClick={() => void killSession(sessionId)}>{t('terminal.kill')}</button>
      ) : null}
    </div>
  );
}

const QUICK_KEYS: Array<{ key: 'terminal.keyEsc' | 'terminal.keyTab' | 'terminal.keyEnter' | 'terminal.keyUp' | 'terminal.keyDown' | 'terminal.keyRight' | 'terminal.keyLeft' | 'terminal.keyCtrlC'; sequence: string; clearsLine?: boolean }> = [
  { key: 'terminal.keyEsc', sequence: '\u001b' },
  { key: 'terminal.keyTab', sequence: '\t' },
  { key: 'terminal.keyEnter', sequence: '\r' },
  { key: 'terminal.keyUp', sequence: '\u001b[A' },
  { key: 'terminal.keyDown', sequence: '\u001b[B' },
  { key: 'terminal.keyRight', sequence: '\u001b[C' },
  { key: 'terminal.keyLeft', sequence: '\u001b[D' },
  { key: 'terminal.keyCtrlC', sequence: '\u0003', clearsLine: true }, // SIGINT cancels the shell line; the UI line must not linger
];

async function killSession(sessionId: string): Promise<void> {
  try {
    const killed = await forceKillTerminals({ sessionId });
    if (!killed.ok) toast.error(translate('terminal.killFailed'));
  } catch {
    toast.error(translate('terminal.killFailed'));
  }
}

function QuickKey({ label, sequence, clearsLine, send, disabled }: { label: string; sequence: string; clearsLine?: boolean; send: (data: string, clearsLine?: boolean) => void; disabled: boolean }): ReactNode {
  return (
    <button type="button" disabled={disabled} className="rounded border border-border/50 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50" data-testid={`terminal-quick-key-${label}`} onClick={() => send(sequence, clearsLine)}>{label}</button>
  );
}

function AttachSelectionButton({ directory, tab }: { directory: string; tab: TerminalTab }): ReactNode {
  const { t } = useI18n();
  const sessionKey = useActiveSessionKey();
  const onClick = useCallback((): void => {
    const selection = window.getSelection();
    const host = document.querySelector('[data-testid="terminal-text"]');
    if (selection === null || selection.isCollapsed || host === null) return;
    const text = selection.toString();
    if (text.trim().length === 0) return; // whitespace-only ignored (section 7.4 step 3)
    useInlineCommentDrafts.getState().addDraft(directory, sessionKey ?? 'draft', {
      source: 'terminal',
      fileLabel: tab.label,
      startLine: 1,
      endLine: 1,
      code: '',
      language: '',
      text,
      terminalId: tab.terminalSessionId ?? tab.id,
    });
    window.dispatchEvent(new CustomEvent(FOCUS_EVENT_NAME)); // section 7.4 step 5
  }, [directory, sessionKey, tab.id, tab.label]);
  return (
    <button type="button" className="rounded border border-border/50 px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground" data-testid="terminal-attach-selection" onClick={onClick}>{t('terminal.attachSelection')}</button>
  );
}
