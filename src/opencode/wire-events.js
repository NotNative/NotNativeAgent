// SPDX-License-Identifier: Apache-2.0
// OpenCode wire event transport: /global/event subscribers, SSE frame output,
// envelope construction (bare frames global vs session-scoped), and the
// durable `sync` mirror pairing. Sequence bookkeeping and the opener/turn
// cadence live with per-session synthesis; this module only moves frames.
import { newId } from '../ids.js';
import { sseFrame, sseClose } from './protocol.js';

export function createWireEventBus() {
  const subscribers = new Set();
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
      return () => dropSubscriber(subscribers, subscriber);
    },
    publishGlobal(type, properties) {
      return publish(subscribers, globalEnvelope(eventId(), type, properties));
    },
    // Why: observed OC shapes — server/global events ride as {payload}; every
    // session-scoped event carries {directory, project, payload}. Durable
    // session events additionally emit a `sync` mirror with the SAME event id,
    // a `.1` type suffix, the per-session monotonic seq, and data = properties.
    publishSession({ directory, sessionID, project, subjectId = null, type, properties, mirror = false, seq = null }) {
      const scope = { project, subjectId };
      if (!mirror) return publish(subscribers, scopedEnvelope(directory, project, eventId(), type, properties), scope);
      const eventIdValue = eventId();
      publish(subscribers, scopedEnvelope(directory, project, eventIdValue, type, properties), scope);
      return publish(subscribers, scopedEnvelope(directory, project, eventId(), 'sync', syncMirror(eventIdValue, type, seq, sessionID, properties)), scope);
    },
    close() {
      for (const subscriber of [...subscribers]) {
        dropSubscriber(subscribers, subscriber);
        sseClose(subscriber.res);
      }
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

function publish(subscribers, envelope, scope = {}) {
  let delivered = 0;
  for (const subscriber of [...subscribers]) {
    const directoryScope = subscriber.directory;
    if (directoryScope !== null && envelope.directory !== undefined && envelope.directory !== directoryScope) continue;
    // A shared workspace is not permission to observe another principal's
    // transcript. The OpenCode-compatible wire body deliberately stays free
    // of this internal routing metadata.
    if (subscriber.subjectId !== null && scope.subjectId !== subscriber.subjectId) continue;
    if (subscriber.workspaceIds !== null && scope.project !== undefined && !subscriber.workspaceIds.has(scope.project)) continue;
    if (!sseFrame(subscriber.res, { data: JSON.stringify(envelope) })) {
      dropSubscriber(subscribers, subscriber);
      continue;
    }
    delivered += 1;
  }
  return delivered;
}

function dropSubscriber(subscribers, subscriber) {
  subscribers.delete(subscriber);
}
