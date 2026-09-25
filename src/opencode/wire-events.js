// SPDX-License-Identifier: Apache-2.0
// OpenCode wire event transport: /global/event subscribers, SSE frame output,
// envelope construction (bare frames global vs session-scoped), and the
// durable `sync` mirror pairing. Sequence bookkeeping and the opener/turn
// cadence live with per-session synthesis; this module only moves frames.
import { newId } from '../ids.js';
import { sseFrame, sseClose } from './protocol.js';

const REPLAY_LIMIT = 2048;
const REPLAY_BYTES_LIMIT = 16 * 1024 * 1024;

export function createWireEventBus() {
  const subscribers = new Set();
  const replay = { entries: [], bytes: 0 };
  return {
    subscribe(res, scope = {}) {
      const subscriber = {
        res, directory: scope.directory ?? null,
        subjectId: scope.subjectId ?? null,
        workspaceIds: Array.isArray(scope.workspaceIds) ? new Set(scope.workspaceIds) : null,
      };
      subscribers.add(subscriber);
      // Why: the opener is a per-connection receipt, not a fan-out broadcast;
      // every existing subscriber must NOT see the new connection's opener.
      sseFrame(res, { data: JSON.stringify(globalEnvelope(eventId(), 'server.connected', {})) });
      const cursor = scope.lastEventId;
      if (typeof cursor === 'string' && cursor.length > 0) {
        const index = replay.entries.findIndex((entry) => entry.envelope.payload.id === cursor);
        // A missing cursor is not proof that a suffix is complete. The client
        // recovers from authoritative snapshots instead of partial replay.
        if (index >= 0) {
          for (const entry of replay.entries.slice(index + 1)) {
            if (!visibleTo(subscriber, entry.envelope, entry.scope)) continue;
            if (!sendEnvelope(subscriber, entry.envelope)) {
              dropSubscriber(subscribers, subscriber);
              break;
            }
          }
        }
      }
      return () => dropSubscriber(subscribers, subscriber);
    },
    publishGlobal(type, properties) {
      return publish(subscribers, replay, globalEnvelope(eventId(), type, properties));
    },
    // Why: observed OC shapes — server/global events ride as {payload}; every
    // session-scoped event carries {directory, project, payload}. Durable
    // session events additionally emit a `sync` mirror with the SAME event id,
    // a `.1` type suffix, the per-session monotonic seq, and data = properties.
    publishSession({ directory, sessionID, project, subjectId = null, workspaceIds = null, type, properties, mirror = false, seq = null }) {
      const scope = { project, subjectId, workspaceIds };
      if (!mirror) return publish(subscribers, replay, scopedEnvelope(directory, project, eventId(), type, properties), scope);
      const eventIdValue = eventId();
      publish(subscribers, replay, scopedEnvelope(directory, project, eventIdValue, type, properties), scope);
      return publish(subscribers, replay, scopedEnvelope(directory, project, eventId(), 'sync', syncMirror(eventIdValue, type, seq, sessionID, properties)), scope);
    },
    close() {
      for (const subscriber of [...subscribers]) {
        dropSubscriber(subscribers, subscriber);
        sseClose(subscriber.res);
      }
      replay.entries.length = 0;
      replay.bytes = 0;
    },
    subscriberCount() { return subscribers.size; },
  };
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

function publish(subscribers, replay, envelope, scope = {}) {
  retainReplay(replay, envelope, scope);
  let delivered = 0;
  for (const subscriber of [...subscribers]) {
    if (!visibleTo(subscriber, envelope, scope)) continue;
    if (!sendEnvelope(subscriber, envelope)) {
      dropSubscriber(subscribers, subscriber);
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

function dropSubscriber(subscribers, subscriber) {
  subscribers.delete(subscriber);
}
