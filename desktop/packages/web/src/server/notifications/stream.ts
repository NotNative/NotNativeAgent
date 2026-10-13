// SPDX-License-Identifier: Apache-2.0
import type { NotificationEvent, NotificationSessions } from './session-state.ts';

/** A slow or revoked client closes; reconnect uses the authenticated snapshot routes. */
export function notificationStream(sessions: NotificationSessions, owner: string, active: () => boolean, signal: AbortSignal): Response {
  let cleanup = (): void => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { cleanup = openStream(controller, sessions, owner, active, signal); },
    cancel() { cleanup(); },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' } });
}

function openStream(controller: ReadableStreamDefaultController<Uint8Array>, sessions: NotificationSessions,
  owner: string, active: () => boolean, signal: AbortSignal): () => void {
  const encoder = new TextEncoder(); let closed = false; let timer: ReturnType<typeof setInterval> | undefined;
  let unsubscribe = (): void => {};
  const close = (): void => {
    if (closed) return; closed = true; unsubscribe(); if (timer) clearInterval(timer); signal.removeEventListener('abort', close);
    try { controller.close(); } catch { /* cancelled stream */ }
  };
  const write = (frame: string): void => {
    if (closed) return;
    if (!active() || (controller.desiredSize ?? 0) <= -64) { close(); return; }
    try { controller.enqueue(encoder.encode(frame)); } catch { close(); }
  };
  const send = (event: NotificationEvent): void => {
    const id = event.type === 'notnative:session-status' ? event.properties.sessionID : undefined;
    const attention = typeof id === 'string' ? sessions.attention(owner, id) : null;
    const projected = attention ? { ...event, properties: { ...event.properties, ...attention } } : event;
    write(`data: ${JSON.stringify(projected)}\n\n`);
  };
  unsubscribe = sessions.subscribe(send);
  signal.addEventListener('abort', close);
  if (signal.aborted) close();
  else {
    send({ type: 'notnative:notification-stream-ready', properties: { uiToken: owner } });
    if (!closed) timer = setInterval(() => write(':heartbeat\n\n'), 20_000);
  }
  return close;
}
