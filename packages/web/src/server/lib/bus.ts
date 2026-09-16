/**
 * Control-stream bus: server-own events fanned out to every SSE subscriber on
 * GET /api/notnative/events (doc 01 §3.2; consumption rules doc 04).
 * Heartbeat 45 s, first frame `event-stream-ready`.
 */
export type ControlEvent = { type: string; payload?: unknown };

type Listener = (event: ControlEvent) => void;

const listeners = new Set<Listener>();

export function publishControlEvent(event: ControlEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // a broken subscriber must never break the publisher
    }
  }
}

export function subscribeControlEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function controlSubscriberCount(): number {
  return listeners.size;
}
