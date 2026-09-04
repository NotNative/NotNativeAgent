// SPDX-License-Identifier: Apache-2.0
import { ContractError, newId } from '../ids.js';

export class FairScheduler {
  #resources = new Map();

  constructor(options = {}) {
    this.configure(options.limit ?? 1, options.maxQueued ?? 256);
  }

  configure(limit, maxQueued) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16
      || !Number.isSafeInteger(maxQueued) || maxQueued < 1 || maxQueued > 4096) {
      throw new ContractError('scheduler_config_invalid', 'scheduler limits are outside their supported bounds');
    }
    this.limit = limit;
    this.maxQueued = maxQueued;
  }

  acquire(resource, owner, signal, onQueued = () => undefined, resourceLimit = null) {
    if (signal.aborted) {
      return Promise.reject(new ContractError('scheduler_cancelled', 'queued provider work was cancelled'));
    }
    const state = this.#state(resource);
    state.limit = effectiveLimit(this.limit, state.discoveredLimit, resourceLimit);
    if (state.running < state.limit && state.queue.length === 0) return Promise.resolve(this.#grant(state, owner));
    if (state.queue.length >= this.maxQueued) throw new ContractError('scheduler_queue_full', 'provider queue is full');
    return new Promise((resolve, reject) => {
      const item = { id: newId('queue'), owner, resolve, reject, signal, onQueued, settled: false };
      const cancel = () => {
        if (item.settled) return;
        item.settled = true;
        state.queue = state.queue.filter((queued) => queued !== item);
        reject(new ContractError('scheduler_cancelled', 'queued provider work was cancelled'));
      };
      item.cancel = cancel;
      signal.addEventListener('abort', cancel, { once: true });
      state.queue.push(item);
      onQueued(state.queue.length);
    });
  }

  snapshot() {
    return Object.freeze([...this.#resources.entries()].map(([resource, state]) => Object.freeze({
      resource, running: state.running, limit: state.limit, discoveredLimit: state.discoveredLimit,
      queued: state.queue.map((item, index) => ({ owner: item.owner, position: index + 1 })),
    })));
  }

  setDiscoveredLimit(resource, limit) {
    if (typeof resource !== 'string' || resource.length < 1
      || (limit !== null && (!Number.isSafeInteger(limit) || limit < 1 || limit > 16))) {
      throw new ContractError('scheduler_resource_limit_invalid', 'discovered provider capacity is invalid');
    }
    const state = this.#state(resource);
    state.discoveredLimit = limit;
    state.limit = effectiveLimit(this.limit, limit, null);
    this.#pump(state);
  }

  #grant(state, owner) {
    state.running += 1;
    state.lastOwner = owner;
    let released = false;
    return () => {
      if (released) return;
      released = true; state.running -= 1; this.#pump(state);
    };
  }

  #pump(state) {
    while (state.running < state.limit && state.queue.length > 0) {
      const index = nextFairIndex(state.queue, state.lastOwner);
      const [item] = state.queue.splice(index, 1);
      item.signal.removeEventListener('abort', item.cancel);
      if (item.signal.aborted) {
        item.cancel();
        continue;
      }
      item.settled = true;
      item.resolve(this.#grant(state, item.owner));
    }
    state.queue.forEach((item, index) => item.onQueued(index + 1));
  }

  #state(resource) {
    if (!this.#resources.has(resource)) {
      this.#resources.set(resource, {
        running: 0, queue: [], lastOwner: null, limit: this.limit, discoveredLimit: null,
      });
    }
    return this.#resources.get(resource);
  }
}

function effectiveLimit(configured, discovered, requested) {
  if (Number.isSafeInteger(discovered) && discovered > 0) {
    return Number.isSafeInteger(requested) && requested > 0 ? Math.min(discovered, requested) : discovered;
  }
  return Number.isSafeInteger(requested) && requested > 0 ? Math.min(configured, requested) : configured;
}

function nextFairIndex(queue, lastOwner) {
  if (lastOwner === null) return 0;
  const different = queue.findIndex((item) => item.owner !== lastOwner);
  return different >= 0 ? different : 0;
}
