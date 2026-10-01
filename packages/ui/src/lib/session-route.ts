// SPDX-License-Identifier: Apache-2.0
import { harnessClient, normalizeDirectory } from './nnd/client.ts';
import { getRuntimeKey } from './runtime-switch.ts';
import { useGlobalSessionsStore } from '../sync/global-stores.ts';
import { useSessionViewStore } from '../sync/view-store.ts';
import { persistLastActiveSession } from '../sync/persist-cache.ts';
import { workspaceRouteUrl } from './workspace-route.ts';

export function routeSessionId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;
}

export function sessionRouteEnabled(): boolean {
  if (typeof window === 'undefined' || window.top !== window.self
    || window.__NOTNATIVE_RUNTIME_APIS__?.runtime.platform === 'vscode') return false;
  const params = new URLSearchParams(window.location.search);
  return !['miniChat', 'ocPanel', 'nn_url_token'].some((key) => params.has(key));
}

/** Explicit draft navigation may keep a null session ID while changing projects. */
let navigationRevision = 0;
export function sessionNavigationRevision(): number { return navigationRevision; }

export function notifySessionRouteNavigation(): void {
  navigationRevision += 1;
  window.dispatchEvent(new Event('notnative:session-route-navigation'));
}

interface RouteState {
  runtime: string;
  generation: number;
  disposed: boolean;
  applying: boolean;
  pending: boolean;
  target: string | null;
}

function routeDirectory(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096 || !value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  return normalizeDirectory(value) || (/^[\\/]+$/u.test(value) ? '/' : null);
}

function selectRoute(state: RouteState, id: string, directory: string): void {
  state.applying = true;
  useSessionViewStore.setState({ currentSessionId: id, activeDirectory: directory });
  persistLastActiveSession(id, directory);
  state.applying = false;
}

async function applyRoute(state: RouteState, onFailure: () => void): Promise<void> {
  const current = ++state.generation;
  const params = new URLSearchParams(window.location.search);
  state.target = params.get('settings')?.trim() ? null : routeSessionId(params.get('session'));
  state.pending = !!state.target;
  if (!state.target) return;
  const id = state.target;
  const known = routeDirectory(useGlobalSessionsStore.getState().directoryOf[id]);
  if (known) { selectRoute(state, id, known); state.pending = false; return; }
  // An omitted option inherits the SDK's current project, which can hide a cold link.
  const result = await harnessClient.getSession(id, { directory: '' }).catch(() => ({ data: undefined, error: 'transport' }));
  if (state.disposed || current !== state.generation || state.runtime !== getRuntimeKey()) return;
  state.pending = false;
  const directory = routeDirectory(result.data?.directory);
  if (result.error || result.data?.id !== id || !directory) { onFailure(); return; }
  // Live list events may have moved the session while this lookup was in flight.
  selectRoute(state, id, routeDirectory(useGlobalSessionsStore.getState().directoryOf[id]) || directory);
}

function clearRuntimeRoute(state: RouteState, event: Event): void {
  const nextRuntime = (event as CustomEvent<{ runtimeKey?: string }>).detail?.runtimeKey;
  if (!nextRuntime || nextRuntime === state.runtime) return;
  state.generation += 1; state.pending = false; state.target = null;
  const url = new URL(window.location.href);
  if (!url.searchParams.has('session')) return;
  url.searchParams.delete('session');
  window.history.replaceState(window.history.state, '', url);
}

/** Session links select only records resolved by the authenticated harness.
 * Navigation never grants permission or dismisses blocking requests. */
export function mountSessionRoute(onFailure: () => void): () => void {
  if (!sessionRouteEnabled()) return () => {};
  const state: RouteState = { runtime: getRuntimeKey(), generation: 0, disposed: false, applying: false, pending: false, target: null };
  const write = (): void => {
    if (state.applying || state.disposed || state.runtime !== getRuntimeKey()) return;
    if (state.pending) { state.generation += 1; state.pending = false; }
    if (new URLSearchParams(window.location.search).get('settings')?.trim()) return;
    state.target = useSessionViewStore.getState().currentSessionId;
    const url = workspaceRouteUrl(window.location.href, state.target, null);
    if (url.href !== window.location.href) window.history.pushState({ session: state.target }, '', url);
    window.dispatchEvent(new Event('notnative:session-route-written'));
  };
  const stopView = useSessionViewStore.subscribe((state, previous) => {
    // Bootstrap's first project/session adoption must leave a cold legacy
    // context link available until the workspace hook can apply it.
    const params = new URLSearchParams(window.location.search);
    if (!previous.activeDirectory && state.activeDirectory && !params.has('session')
      && (params.has('tab') || params.has('file'))) return;
    if (state.currentSessionId !== previous.currentSessionId) write();
  });
  const stopList = useGlobalSessionsStore.subscribe((list) => {
    if (!state.target || state.pending || useSessionViewStore.getState().currentSessionId !== state.target) return;
    const directory = routeDirectory(list.directoryOf[state.target]);
    if (directory && directory !== useSessionViewStore.getState().activeDirectory) selectRoute(state, state.target, directory);
  });
  const pop = (): void => { void applyRoute(state, onFailure); };
  const runtimeChange = (event: Event): void => clearRuntimeRoute(state, event);
  const settingsChange = (): void => { state.generation += 1; state.pending = false; state.target = useSessionViewStore.getState().currentSessionId; };
  window.addEventListener('popstate', pop);
  window.addEventListener('notnative:session-route-navigation', write);
  window.addEventListener('notnative:runtime-endpoint-will-change', runtimeChange);
  window.addEventListener('notnative:route-settings-changed', settingsChange);
  void applyRoute(state, onFailure);
  return () => {
    state.disposed = true; state.generation += 1; stopView(); stopList();
    window.removeEventListener('popstate', pop);
    window.removeEventListener('notnative:session-route-navigation', write);
    window.removeEventListener('notnative:runtime-endpoint-will-change', runtimeChange);
    window.removeEventListener('notnative:route-settings-changed', settingsChange);
  };
}
