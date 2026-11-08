// SPDX-License-Identifier: Apache-2.0
import { newId } from '../ids.js';
import { sseOpen, sseFrame } from './protocol.js';

// Compatibility: v2 uses native event data, not the v1 payload/sync envelopes.
// The published client defines this stream as live-only and does not replay it.
export function createV2Events() {
  const subscribers = new Set();
  // Invariant: a consumer that cannot keep up is closed, not merely forgotten.
  // Dropping it from the set alone leaves its response and socket alive, and the
  // live subscriber count would understate the connections this stream owns.
  const drop = (res) => {
    subscribers.delete(res);
    try { res.destroy(); } catch { /* the socket is already gone */ }
  };
  const write = (res, event) => {
    if (res.destroyed || res.writableEnded) { subscribers.delete(res); return; }
    let writable;
    try { writable = res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); }
    catch { writable = false; }
    // Invariant: slow consumers must reconnect and fetch snapshots, not grow an unbounded queue.
    if (!writable) drop(res);
  };
  const timer = setInterval(() => {
    for (const res of [...subscribers]) {
      if (res.destroyed || res.writableEnded) { subscribers.delete(res); continue; }
      let writable;
      try { writable = res.write(': heartbeat\n\n'); }
      catch { writable = false; }
      if (!writable) drop(res);
    }
  }, 10_000);
  timer.unref();
  return {
    subscribe(res) {
      if (subscribers.size >= 64) return false;
      sseOpen(res);
      // Why created: every other event carries one, and the client reads a
      // missing value as "now". Sending the real time keeps one envelope shape
      // instead of a special case for the opener frame.
      if (!sseFrame(res, { event: 'server.connected', data: JSON.stringify({
        id: newId('evt'), created: Date.now(), type: 'server.connected', data: {},
      }) })) {
        drop(res);
        return true;
      }
      subscribers.add(res);
      res.on('close', () => subscribers.delete(res));
      return true;
    },
    emit(state, type, data, durable = true, version = 1) {
      const event = { id: newId('evt'), created: Date.now(), type, location: state.info.location, data };
      // Compatibility: the durable envelope carries the schema version the client
      // declares per type. Two tool events were raised to version 2; the rest of
      // the vocabulary is version 1, which is what a plain `durable` publishes.
      if (durable) event.durable = { aggregateID: state.info.id, seq: ++state.sequence, version };
      for (const res of subscribers) write(res, event);
      return event;
    },
    close() { clearInterval(timer); for (const res of subscribers) res.end(); subscribers.clear(); },
  };
}
