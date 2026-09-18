// SPDX-License-Identifier: Apache-2.0
/**
 * Terminal session observer (doc 07 section 7.3): one loop PER directory
 * scope, 5 s cadence while visible + online, coalesced in-flight requests,
 * wake refresh on focus/visibility/online (visible+online only: hiding is a
 * pause, not a refresh), runtime-guarded results (stale data never
 * resurrects tabs). The last unsubscribe closes the loop AND deletes the
 * scope: dead directories cannot accumulate.
 */
import { getRuntimeKey } from '../runtime-switch.ts';
import { listTerminalSessions, touchTerminalSessions } from '../server-api.ts';
import { normalizeTerminalDirectory } from './store.ts';

export const OBSERVER_CADENCE_MS = 5_000;
export const KEEPALIVE_TOUCH_MS = 10 * 60_000;

interface ObserverScope {
  directory: string;
  listeners: Set<(sessions: Awaited<ReturnType<typeof listTerminalSessions>>) => void>;
  timer: number | null;
  inFlight: boolean;
  refreshAgain: boolean;
}

const scopes = new Map<string, ObserverScope>();

function scopeFor(directory: string): ObserverScope {
  const key = normalizeTerminalDirectory(directory) || '*';
  let scope = scopes.get(key);
  if (scope === undefined) {
    scope = { directory: key, listeners: new Set(), timer: null, inFlight: false, refreshAgain: false };
    scopes.set(key, scope);
  }
  return scope;
}

/** The invariant is "authoritative refresh on recovery, never a background
 * storm": a wake while hidden or offline stays a no-op (E-07-15). */
function pausedForViewport(): boolean {
  return document.hidden || navigator.onLine === false;
}

function requestRun(scope: ObserverScope): void {
  if (scope.inFlight) {
    scope.refreshAgain = true; // coalescing: one request per tick across consumers
    return;
  }
  scope.inFlight = true;
  const startedKey = getRuntimeKey();
  void listTerminalSessions(scope.directory === '*' ? '' : scope.directory)
    .then((sessions) => {
      if (getRuntimeKey() !== startedKey) return; // runtime drop: stale data never resurrects tabs
      for (const listener of [...scope.listeners]) listener(sessions);
    })
    .catch(() => undefined)
    .finally(() => {
      scope.inFlight = false;
      if (scope.refreshAgain) {
        scope.refreshAgain = false;
        requestRun(scope);
      }
    });
}

function startTimer(scope: ObserverScope): void {
  if (scope.timer !== null) return;
  scope.timer = window.setInterval(() => {
    if (pausedForViewport()) return; // pause while hidden/offline
    requestRun(scope);
  }, OBSERVER_CADENCE_MS);
}

function stopScope(scope: ObserverScope): void {
  if (scope.timer !== null) window.clearInterval(scope.timer);
  scope.timer = null;
}

export function observeTerminalSessions(
  directory: string,
  listener: (sessions: Awaited<ReturnType<typeof listTerminalSessions>>) => void,
): () => void {
  const scope = scopeFor(directory);
  scope.listeners.add(listener);
  requestRun(scope); // every new scope/consumer triggers an immediate refresh
  startTimer(scope);
  const wake = (): void => {
    if (pausedForViewport()) return;
    requestRun(scope);
  };
  window.addEventListener('focus', wake);
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('online', wake);
  return () => {
    scope.listeners.delete(listener);
    window.removeEventListener('focus', wake);
    document.removeEventListener('visibilitychange', wake);
    window.removeEventListener('online', wake);
    if (scope.listeners.size === 0) {
      stopScope(scope); // loops close with their last listener
      scopes.delete(scope.directory); // dead directory scopes cannot accumulate
    }
  };
}

/** 10-min keepalive touch loop for listed session ids (background tabs
 * hold no WS attachment, so this fights the idle reaper per section 3.6). */
export function startKeepaliveTouch(getSessionIds: () => string[]): () => void {
  const timer = window.setInterval(() => {
    const ids = getSessionIds();
    if (ids.length === 0) return;
    void touchTerminalSessions(ids);
  }, KEEPALIVE_TOUCH_MS);
  return () => window.clearInterval(timer);
}

export function __resetObserverForTests(): void {
  for (const scope of [...scopes.values()]) stopScope(scope);
  scopes.clear();
}
