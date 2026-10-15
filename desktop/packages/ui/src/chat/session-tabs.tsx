// SPDX-License-Identifier: Apache-2.0
/**
 * Session header tabs (doc 05 §D.9, v1): one tab per recently-opened session;
 * close activates the LEFT neighbor else the rightmost remaining else the
 * draft; digit keys activate renderable tabs (digit matches visible order);
 * tabs order persists for the page lifetime; no tombstones (a closed session
 * reopens cleanly when selected again).
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useSessionViewStore } from '../sync/view-store.ts';
import { useGlobalSessionsStore, useGlobalSessionStatusStore } from '../sync/global-stores.ts';
import type { SyncEngine } from '../sync/sync-engine.ts';
import type { Session, SessionStatus } from '../lib/nnd/types.ts';

const TAB_LIMIT = 9;

export interface SessionTabsProps {
  engine: SyncEngine;
  directory: string;
  onActivate?: (session: Session | null) => void;
}

function useTabList(current: string | null, available: Session[]): { sessions: Session[]; close: (sessionID: string, activate: (session: Session | null) => void) => void } {
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    if (current && !ids.includes(current)) setIds((prev) => prev.includes(current) ? prev : [...prev, current].slice(-TAB_LIMIT));
  }, [current]);
  return {
    sessions: ids.map((id) => available.find((session) => session.id === id)).filter((session): session is Session => Boolean(session)),
    close: (sessionID, activate) => {
      const index = ids.indexOf(sessionID);
      if (index < 0) return;
      const next = ids.filter((id) => id !== sessionID);
      setIds(next);
      if (useSessionViewStore.getState().currentSessionId !== sessionID) return;
      const neighbor = index > 0 ? next[index - 1] ?? next.at(-1) : next.at(0);
      activate(available.find((session) => session.id === neighbor) ?? null);
    },
  };
}

function badge(status: SessionStatus | undefined): string {
  if (!status || status.type === 'idle') return '';
  return status.type === 'busy' ? '●' : '↻';
}

export function SessionTabs({ engine, directory, onActivate }: SessionTabsProps): ReactNode {
  void engine;
  void directory;
  const view = useSyncExternalStore(useSessionViewStore.subscribe, useSessionViewStore.getState);
  const available = useSyncExternalStore(useGlobalSessionsStore.subscribe, useGlobalSessionsStore.getState).active;
  const statuses = useSyncExternalStore(useGlobalSessionStatusStore.subscribe, useGlobalSessionStatusStore.getState).statusById;
  const { sessions, close } = useTabList(view.currentSessionId, available);
  if (sessions.length === 0) return null;

  function activate(session: Session | null): void {
    if (onActivate) { onActivate(session); return; }
    useSessionViewStore.setState({ currentSessionId: session?.id ?? null,
      activeDirectory: session?.directory ?? useSessionViewStore.getState().activeDirectory });
  }

  function onDigit(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (!/^[1-9]$/.test(event.key)) return;
    const target = sessions[Number(event.key) - 1];
    if (target) activate(target);
  }

  return (
    <div className="flex min-w-0 items-center gap-1 overflow-x-auto px-2" role="tablist" aria-label="Open sessions" data-testid="session-tabs" onKeyDown={onDigit}>
      {sessions.map((session, index) => (
        <span key={session.id} role="tab" aria-selected={view.currentSessionId === session.id}
          className={`flex max-w-48 items-center gap-1 rounded-t-lg px-3 py-1.5 text-[12px] ${view.currentSessionId === session.id ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500 hover:bg-white/5'}`}>
          <button type="button" className="truncate" onClick={() => activate(session)}>
            <span aria-hidden className="mr-1 text-[10px] text-neutral-600">{index + 1}</span>
            <span aria-hidden className="mr-1">{badge(statuses[session.id])}</span>
            {session.title || 'Untitled Session'}
          </button>
          <button type="button" aria-label={`Close ${session.title || 'session'} tab`} className="text-neutral-600 hover:text-neutral-200" onClick={() => close(session.id, activate)}>×</button>
        </span>
      ))}
    </div>
  );
}
