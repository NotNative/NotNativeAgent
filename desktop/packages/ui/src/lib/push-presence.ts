// SPDX-License-Identifier: Apache-2.0
import type { PushApi } from './api/push-types.ts';
import { beginBrowserBadgeRequest } from './browser-badge.ts';

/** getRandomValues remains available on LAN HTTP pages, unlike randomUUID. */
export function pushPresenceId(source: Pick<Crypto, 'getRandomValues'>): string {
  return Array.from(source.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** One mounted surface owns one lease; writes serialize and coalesce to its latest state. */
export function startPushPresence(input: {
  api: PushApi; clientId: string; current: () => boolean;
  window: Window; document: Document;
}): () => void {
  let stopped = false;
  let pending = false;
  let desired = false;
  let sequence = 0;
  let pageActive = true;
  const send = () => {
    if (pending || !input.current()) return;
    const visible = desired;
    pending = true;
    const apply = beginBrowserBadgeRequest();
    void input.api.setVisibility({ visible, clientId: input.clientId, sequence: ++sequence, platform: 'web' })
      .then((reply) => { if (reply.badge && input.current()) apply(reply.badge, input.window.navigator); })
      .catch(() => undefined).finally(() => {
        pending = false;
        if (visible !== desired && input.current()) send();
      });
  };
  const update = () => {
    if (stopped) return;
    desired = pageActive && input.document.visibilityState === 'visible' && input.document.hasFocus();
    send();
  };
  const hide = () => { pageActive = false; desired = false; send(); };
  const show = () => { pageActive = true; update(); };
  input.document.addEventListener('visibilitychange', update);
  input.window.addEventListener('focus', update);
  input.window.addEventListener('blur', update);
  input.window.addEventListener('pageshow', show);
  input.window.addEventListener('pagehide', hide);
  const timer = setInterval(update, 20_000);
  update();
  return () => {
    stopped = true;
    clearInterval(timer);
    input.document.removeEventListener('visibilitychange', update);
    input.window.removeEventListener('focus', update);
    input.window.removeEventListener('blur', update);
    input.window.removeEventListener('pageshow', show);
    input.window.removeEventListener('pagehide', hide);
    hide();
  };
}
