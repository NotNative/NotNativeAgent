// SPDX-License-Identifier: Apache-2.0
import type { PushApi } from './api/push-types.ts';
import { beginBrowserBadgeRequest } from './browser-badge.ts';
import { useSessionViewStore } from '../sync/view-store.ts';

export function startSessionBadges(api: PushApi, current: () => boolean): () => void {
  let stopped = false;
  const reset = (sessionId: unknown, reason: 'view' | 'message-sent'): void => {
    if (!current() || !api.resetBadge || typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) return;
    const apply = beginBrowserBadgeRequest();
    void api.resetBadge(sessionId, reason).then((badge) => {
      if (!stopped && current()) apply(badge, navigator);
    }).catch(() => undefined);
  };
  const view = (): void => {
    if (document.visibilityState === 'visible' && document.hasFocus()) reset(useSessionViewStore.getState().currentSessionId, 'view');
  };
  const sent = (event: Event): void => reset((event as CustomEvent<{ sessionId?: unknown }>).detail?.sessionId, 'message-sent');
  const stopView = useSessionViewStore.subscribe((state, previous) => { if (state.currentSessionId !== previous.currentSessionId) view(); });
  window.addEventListener('focus', view); document.addEventListener('visibilitychange', view);
  window.addEventListener('notnative:message-sent', sent);
  view();
  return () => { stopped = true; stopView(); window.removeEventListener('focus', view); document.removeEventListener('visibilitychange', view); window.removeEventListener('notnative:message-sent', sent); };
}
