// SPDX-License-Identifier: Apache-2.0
import { newId } from '../ids.js';
import { sseOpen, sseFrame } from './protocol.js';

// Compatibility: v2 uses native event data, not the v1 payload/sync envelopes.
// The published client defines this stream as live-only and does not replay it.
export function createV2Events() {
  const subscribers = new Set();
  const write = (res, event) => {
    if (res.destroyed || res.writableEnded) { subscribers.delete(res); return; }
    if (!res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)) {
      // Invariant: slow consumers must reconnect and fetch snapshots, not grow an unbounded queue.
      subscribers.delete(res); res.destroy();
    }
  };
  const timer = setInterval(() => {
    for (const res of subscribers) {
      if (!res.write(': heartbeat\n\n')) { subscribers.delete(res); res.destroy(); }
    }
  }, 10_000);
  timer.unref();
  return {
    subscribe(res) {
      if (subscribers.size >= 64) return false;
      sseOpen(res);
      sseFrame(res, { event: 'server.connected', data: JSON.stringify({ id: newId('evt'), type: 'server.connected', data: {} }) });
      subscribers.add(res);
      res.on('close', () => subscribers.delete(res));
      return true;
    },
    emit(state, type, data, durable = true) {
      const event = { id: newId('evt'), created: Date.now(), type, location: state.info.location, data };
      if (durable) event.durable = { aggregateID: state.info.id, seq: ++state.sequence, version: 1 };
      for (const res of subscribers) write(res, event);
      return event;
    },
    close() { clearInterval(timer); for (const res of subscribers) res.end(); subscribers.clear(); },
  };
}
