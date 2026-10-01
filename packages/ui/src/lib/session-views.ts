// SPDX-License-Identifier: Apache-2.0
import type { PushApi } from './api/push-types.ts';
import { beginBrowserBadgeRequest } from './browser-badge.ts';
import { useSessionViewStore } from '../sync/view-store.ts';

export function startSessionViews(api: PushApi, current: () => boolean, clientId: string): () => void {
  let viewed: string | null = null; let sequence = 0; let active = true;
  const report = (session: string, visible: boolean): void => {
    if (!current() || !api.setSessionViewed) return;
    const apply = beginBrowserBadgeRequest();
    void api.setSessionViewed(session, visible, clientId, ++sequence).then((reply) => {
      if (reply.badge && current()) apply(reply.badge, navigator);
    }).catch(() => undefined);
  };
  const update = (): void => {
    const next = active && document.visibilityState === 'visible' && document.hasFocus() ? useSessionViewStore.getState().currentSessionId : null;
    if (viewed && viewed !== next) report(viewed, false);
    viewed = next; if (next) report(next, true);
  };
  const hide = (): void => { active = false; update(); };
  const show = (): void => { active = true; update(); };
  const unsubscribe = useSessionViewStore.subscribe((state, previous) => { if (state.currentSessionId !== previous.currentSessionId) update(); });
  window.addEventListener('focus', update); window.addEventListener('blur', update); document.addEventListener('visibilitychange', update);
  window.addEventListener('pagehide', hide); window.addEventListener('pageshow', show);
  const timer = setInterval(update, 20_000); update();
  return () => {
    hide(); unsubscribe(); clearInterval(timer);
    window.removeEventListener('focus', update); window.removeEventListener('blur', update); document.removeEventListener('visibilitychange', update);
    window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show);
  };
}
