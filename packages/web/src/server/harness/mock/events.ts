/**
 * Mock harness event hub — doc 02 §5.1/P-06.
 * Envelope: {directory, payload:{id, type, properties}} on every stream.
 * Replay: bounded ring (2048 events); `Last-Event-ID` resumes after the cursor;
 * an unknown cursor replays nothing (clients must resync from snapshots).
 */
import { sseResponse } from '../../lib/sse.ts';
import type { GlobalEvent } from '../../../../../ui/src/lib/nna/types.ts';

const RING_LIMIT = 2048;
const HEARTBEAT_MS = 20_000;

type Listener = (envelope: GlobalEvent) => void;

const listeners = new Set<Listener>();
const ring: GlobalEvent[] = [];
let seq = 0;

export function emitEvent(directory: string, type: string, properties: Record<string, unknown>): void {
  const envelope: GlobalEvent = {
    directory,
    payload: { id: String(++seq), type, properties },
  };
  ring.push(envelope);
  if (ring.length > RING_LIMIT) ring.splice(0, ring.length - RING_LIMIT);
  for (const listener of [...listeners]) {
    try {
      listener(envelope);
    } catch {
      /* a dead stream must not break the emitter */
    }
  }
}

function replayAfter(lastEventId: string | null, directory: string | null): GlobalEvent[] {
  const matches = (env: GlobalEvent) =>
    directory === null || env.directory === directory || env.directory === 'global';
  if (lastEventId === null) return []; // fresh connect: no replay (client boots from snapshots)
  const index = ring.findIndex((env) => env.payload.id === lastEventId);
  if (index < 0) return []; // unknown cursor → authoritative resync, no partial-truth replay
  return ring.slice(index + 1).filter(matches);
}

/** GET /global/event (directory=null) or GET /event?directory=… (scoped). */
export function openEventStream(request: Request, directory: string | null): Response {
  const lastEventId = request.headers.get('last-event-id');
  return sseResponse((send) => {
    for (const env of replayAfter(lastEventId, directory)) {
      send({ id: env.payload.id, data: JSON.stringify(env) });
    }
    const listener: Listener = (env) => {
      if (directory !== null && env.directory !== directory && env.directory !== 'global') return;
      send({ id: env.payload.id, data: JSON.stringify(env) });
    };
    listeners.add(listener);
    const heartbeat = setInterval(() => send({ comment: 'heartbeat' }), HEARTBEAT_MS);
    return () => {
      listeners.delete(listener);
      clearInterval(heartbeat);
    };
  }, request.signal);
}

export const eventCursor = () => String(seq);
