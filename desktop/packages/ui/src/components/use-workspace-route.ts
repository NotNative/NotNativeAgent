// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SettingsPageSlug } from './settings/search.ts';
import { parseWorkspaceRoute, requestContextRoute, useContextRouteStore, workspaceRouteUrl } from '../lib/workspace-route.ts';
import { sessionRouteEnabled } from '../lib/session-route.ts';
import { useSessionViewStore } from '../sync/view-store.ts';

export function useWorkspaceRoute(runtime: string, showChat: () => void) {
  const [route, setRoute] = useState(() => parseWorkspaceRoute(sessionRouteEnabled() ? window.location.search : ''));
  const [settingsPage, setSettingsPage] = useState<SettingsPageSlug | null>(route.settings);
  const directory = useSessionViewStore((state) => state.activeDirectory);
  const session = useSessionViewStore((state) => state.currentSessionId);
  const initial = useRef(true);
  useEffect(() => {
    if (!sessionRouteEnabled()) return;
    const pop = (): void => {
      const next = parseWorkspaceRoute(window.location.search);
      setRoute(next); setSettingsPage(next.settings);
    };
    const navigated = (): void => { useContextRouteStore.setState({ request: null }); setRoute(parseWorkspaceRoute(window.location.search)); };
    pop();
    window.addEventListener('popstate', pop);
    window.addEventListener('notnative:session-route-written', navigated);
    return () => { window.removeEventListener('popstate', pop); window.removeEventListener('notnative:session-route-written', navigated); };
  }, [runtime]);
  useEffect(() => {
    if (!sessionRouteEnabled() || settingsPage || !directory || route.session && route.session !== session) return;
    const tab = route.tab ?? (route.file ? 'diff' : null);
    if (!tab) return;
    showChat();
    requestContextRoute({ runtime, directory, session, tab, file: tab === 'diff' ? route.file : null });
  }, [runtime, directory, session, route, settingsPage, showChat]);
  useEffect(() => {
    if (!initial.current || !sessionRouteEnabled() || !settingsPage && (
      route.session && route.session !== session || (route.tab || route.file) && !directory
    )) return;
    initial.current = false;
    writeWorkspaceRoute(session, settingsPage, true);
  }, [route.session, route.tab, route.file, directory, session, settingsPage]);
  const navigateSettings = useCallback((page: SettingsPageSlug | null): void => {
    setSettingsPage(page);
    if (sessionRouteEnabled()) {
      writeWorkspaceRoute(useSessionViewStore.getState().currentSessionId, page, false);
      setRoute(parseWorkspaceRoute(window.location.search));
      useContextRouteStore.setState({ request: null });
      // Opening settings cancels any pending session resolution before it can repaint.
      window.dispatchEvent(new Event('notnative:route-settings-changed'));
    }
  }, []);
  return { settingsPage, openSettings: navigateSettings, closeSettings: () => navigateSettings(null) };
}

function writeWorkspaceRoute(session: string | null, settings: SettingsPageSlug | null, replace: boolean): void {
  const url = workspaceRouteUrl(window.location.href, session, settings);
  if (url.href === window.location.href) return;
  const state = { route: { session, settings } };
  if (replace) window.history.replaceState(state, '', url);
  else window.history.pushState(state, '', url);
}
