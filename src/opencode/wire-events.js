// SPDX-License-Identifier: Apache-2.0
// OpenCode wire event transport: /global/event subscribers, SSE frame output,
// envelope construction (bare frames global vs session-scoped), and the
// durable `sync` mirror pairing. Sequence bookkeeping and the opener/turn
// cadence live with per-session synthesis; this module only moves frames.
import { newId } from '../ids.js';
import { sseFrame, sseClose } from './protocol.js';

const REPLAY_LIMIT = 2048;
const REPLAY_BYTES_LIMIT = 16 * 1024 * 1024;
// NND considers an idle event stream stale after 30 seconds. A comment frame
// keeps the transport alive without creating a replayable event or cursor.
const HEARTBEAT_INTERVAL_MS = 10_000;

export function createWireEventBus({ heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS } = {}) {
  const { subscribers, add, remove } = createSubscriberRegistry(heartbeatIntervalMs);
  const replay = { entries: [], bytes: 0 };
  return {
    subscribe(res, scope = {}) {
      const subscriber = {
        res, directory: scope.directory ?? null,
        subjectId: scope.subjectId ?? null,
        workspaceIds: Array.isArray(scope.workspaceIds) ? new Set(scope.workspaceIds) : null,
      };
      add(subscriber);
      const { replayStatus, replayIndex } = replayAdmission(replay.entries, scope.lastEventId, subscriber);
      // Why: the opener is a per-connection receipt, not a fan-out broadcast;
      // every existing subscriber must NOT see the new connection's opener.
      sseFrame(res, { data: JSON.stringify(globalEnvelope(eventId(), 'server.connected', { replayStatus })) });
      if (replayStatus === 'complete') {
        for (const entry of replay.entries.slice(replayIndex + 1)) {
          if (!visibleTo(subscriber, entry.envelope, entry.scope)) continue;
          if (!sendEnvelope(subscriber, entry.envelope)) {
            remove(subscriber);
            break;
          }
        }
      }
      return () => remove(subscriber);
    },
    publishGlobal(type, properties) {
      return publish(subscribers, replay, globalEnvelope(eventId(), type, properties), {}, remove);
    },
    /** Retained, session-scoped bookmark. The next SSE subscription either
     * replays strictly after it or reports gap if this ring/generation lost it. */
    checkpointSession({ directory, sessionID, project, subjectId, workspaceIds }) {
      const id = eventId();
      const scope = { project, subjectId, workspaceIds };
      retainReplay(replay, scopedEnvelope(directory, project, id, 'nnd.activity.boundary', { sessionID }), scope);
      return replay.entries.some((entry) => entry.envelope.payload.id === id) ? id : null;
    },
    // Why: observed OC shapes — server/global events ride as {payload}; every
    // session-scoped event carries {directory, project, payload}. Durable
    // session events additionally emit a `sync` mirror with the SAME event id,
    // a `.1` type suffix, the per-session monotonic seq, and data = properties.
    publishSession({ directory, sessionID, project, subjectId = null, workspaceIds = null, type, properties, mirror = false, seq = null }) {
      const scope = { project, subjectId, workspaceIds };
      if (!mirror) return publish(subscribers, replay, scopedEnvelope(directory, project, eventId(), type, properties), scope, remove);
      const eventIdValue = eventId();
      publish(subscribers, replay, scopedEnvelope(directory, project, eventIdValue, type, properties), scope, remove);
      return publish(subscribers, replay, scopedEnvelope(directory, project, eventId(), 'sync', syncMirror(eventIdValue, type, seq, sessionID, properties)), scope, remove);
    },
    close() {
      for (const subscriber of [...subscribers]) {
        remove(subscriber);
        sseClose(subscriber.res);
      }
      replay.entries.length = 0;
      replay.bytes = 0;
    },
    subscriberCount() { return subscribers.size; },
  };
}

function createSubscriberRegistry(heartbeatIntervalMs) {
  const subscribers = new Set();
  let timer = null;
  const remove = (subscriber) => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
  const heartbeat = () => {
    for (const subscriber of [...subscribers]) {
      if (subscriber.res.destroyed || subscriber.res.writableEnded) { remove(subscriber); continue; }
      try { subscriber.res.write(': heartbeat\n\n'); }
      catch { remove(subscriber); }
    }
  };
  const add = (subscriber) => {
    subscribers.add(subscriber);
    if (timer === null) {
      timer = setInterval(heartbeat, heartbeatIntervalMs);
      timer.unref?.();
    }
  };
  return { subscribers, add, remove };
}

export function wireEnvelopeShapes() {
  return { global: ['payload'], scoped: ['directory', 'payload', 'project'] };
}

function globalEnvelope(id, type, properties) {
  return { payload: { id, type, properties } };
}

function scopedEnvelope(directory, project, id, type, properties) {
  return { directory, project, payload: { id, type, properties } };
}

function syncMirror(eventIdValue, type, seq, sessionID, data) {
  return { type: 'sync', syncEvent: { id: eventIdValue, type: `${type}.1`, seq, aggregateID: sessionID, data } };
}

function eventId() { return newId('evt'); }

function replayAdmission(entries, cursor, subscriber) {
  if (cursor === undefined || cursor === null || cursor === '') return { replayStatus: 'fresh', replayIndex: -1 };
  // Security: a cursor outside the caller's current scope cannot certify a
  // complete replay, even if its event remains in the shared retention ring.
  if (typeof cursor !== 'string' || cursor.length > 256) return { replayStatus: 'gap', replayIndex: -1 };
  const replayIndex = entries.findIndex((entry) => entry.envelope.payload.id === cursor);
  if (replayIndex < 0 || !visibleTo(subscriber, entries[replayIndex].envelope, entries[replayIndex].scope)
    || entries[replayIndex].envelope.payload.type === 'nnd.activity.boundary'
      && !sameCheckpointScope(subscriber, entries[replayIndex].scope)) {
    return { replayStatus: 'gap', replayIndex: -1 };
  }
  return { replayStatus: 'complete', replayIndex };
}

function sameCheckpointScope(subscriber, scope) {
  if (subscriber.subjectId !== scope.subjectId || !subscriber.workspaceIds
    || !Array.isArray(scope.workspaceIds) || subscriber.workspaceIds.size !== scope.workspaceIds.length) return false;
  return scope.workspaceIds.every((id) => subscriber.workspaceIds.has(id));
}

function publish(subscribers, replay, envelope, scope, remove) {
  retainReplay(replay, envelope, scope);
  let delivered = 0;
  for (const subscriber of [...subscribers]) {
    if (!visibleTo(subscriber, envelope, scope)) continue;
    if (!sendEnvelope(subscriber, envelope)) {
      remove(subscriber);
      continue;
    }
    delivered += 1;
  }
  return delivered;
}

function retainReplay(replay, envelope, scope) {
  const bytes = Buffer.byteLength(JSON.stringify(envelope), 'utf8');
  if (bytes > REPLAY_BYTES_LIMIT) {
    // The ring must remain a contiguous suffix. Retaining events on either
    // side of an omitted giant frame would falsely claim complete replay.
    replay.entries.length = 0;
    replay.bytes = 0;
    return;
  }
  replay.entries.push({ envelope, scope, bytes });
  replay.bytes += bytes;
  while (replay.entries.length > REPLAY_LIMIT || replay.bytes > REPLAY_BYTES_LIMIT) {
    replay.bytes -= replay.entries.shift().bytes;
  }
}

function visibleTo(subscriber, envelope, scope) {
  const directoryScope = subscriber.directory;
  if (directoryScope !== null && envelope.directory !== undefined && envelope.directory !== directoryScope) return false;
  // A shared workspace is not permission to observe another principal's
  // transcript. The OpenCode-compatible wire body stays free of routing data.
  if (subscriber.subjectId !== null && scope.subjectId !== subscriber.subjectId) return false;
  if (subscriber.workspaceIds !== null && scope.project !== undefined && !subscriber.workspaceIds.has(scope.project)) return false;
  // Multi-workspace grants require every original workspace, not just the
  // first one visible on the event envelope.
  if (scope.workspaceIds != null && (!subscriber.workspaceIds
    || scope.workspaceIds.some((id) => !subscriber.workspaceIds.has(id)))) return false;
  return true;
}

function sendEnvelope(subscriber, envelope) {
  return sseFrame(subscriber.res, { id: envelope.payload.id, data: JSON.stringify(envelope) });
}
