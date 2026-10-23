// SPDX-License-Identifier: Apache-2.0
import { ContractError, newId } from '../ids.js';

export const MAX_PROVIDER_CONCURRENCY = 16;

export class FairScheduler {
  #resources = new Map();

  constructor(options = {}) {
    this.configure(options.limit ?? 1, options.maxQueued ?? 256);
  }

  configure(limit, maxQueued) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PROVIDER_CONCURRENCY
      || !Number.isSafeInteger(maxQueued) || maxQueued < 1 || maxQueued > 4096) {
      throw new ContractError('scheduler_config_invalid', 'scheduler limits are outside their supported bounds');
    }
    this.limit = limit;
    this.maxQueued = maxQueued;
    for (const state of this.#resources.values()) this.#pump(state);
  }

  acquire(resource, owner, signal, onQueued = () => undefined, resourceLimit = null) {
    if (signal.aborted) {
      return Promise.reject(new ContractError('scheduler_cancelled', 'queued provider work was cancelled'));
    }
    const state = this.#state(resource);
    if (state.queue.length >= this.maxQueued) {
      return Promise.reject(new ContractError('scheduler_queue_full', 'provider queue is full'));
    }
    const requestLimit = boundedRequestLimit(resourceLimit);
    const admissionLimit = Math.min(state.limit, requestLimit);
    if (state.running < admissionLimit && state.queue.length === 0) {
      return Promise.resolve(this.#grant(state, owner, requestLimit));
    }
    return new Promise((resolve, reject) => {
      const item = { id: newId('queue'), owner, resolve, reject, signal, onQueued,
        requestLimit, settled: false };
      const cancel = () => {
        if (item.settled) return;
        item.settled = true;
        state.queue = state.queue.filter((queued) => queued !== item);
        signal.removeEventListener('abort', cancel);
        reject(new ContractError('scheduler_cancelled', 'queued provider work was cancelled'));
        this.#pump(state);
      };
      item.cancel = cancel;
      signal.addEventListener('abort', cancel, { once: true });
      state.queue.push(item);
      this.#refreshLimit(state);
      notifyQueued(onQueued, state.queue.length);
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
      || (limit !== null && (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PROVIDER_CONCURRENCY))) {
      throw new ContractError('scheduler_resource_limit_invalid', 'discovered provider capacity is invalid');
    }
    const state = this.#state(resource);
    state.discoveredLimit = limit;
    this.#pump(state);
  }

  #grant(state, owner, requestLimit) {
    state.running += 1;
    state.lastOwner = owner;
    const grant = { requestLimit };
    state.active.add(grant);
    this.#refreshLimit(state);
    let released = false;
    return () => {
      if (released) return;
      released = true; state.running -= 1; state.active.delete(grant); this.#pump(state);
    };
  }

  #pump(state) {
    this.#refreshLimit(state);
    while (state.running < state.limit && state.queue.length > 0) {
      const index = nextFairIndex(state.queue, state.lastOwner);
      const [item] = state.queue.splice(index, 1);
      item.signal.removeEventListener('abort', item.cancel);
      if (item.signal.aborted) {
        item.cancel();
        continue;
      }
      item.settled = true;
      item.resolve(this.#grant(state, item.owner, item.requestLimit));
    }
    state.queue.forEach((item, index) => notifyQueued(item.onQueued, index + 1));
  }

  #refreshLimit(state) {
    let limit = effectiveLimit(this.limit, state.discoveredLimit, null);
    for (const grant of state.active) limit = Math.min(limit, grant.requestLimit);
    for (const item of state.queue) limit = Math.min(limit, item.requestLimit);
    state.limit = limit;
  }

  #state(resource) {
    if (!this.#resources.has(resource)) {
      this.#resources.set(resource, {
        running: 0, queue: [], active: new Set(), lastOwner: null, limit: this.limit, discoveredLimit: null,
      });
    }
    return this.#resources.get(resource);
  }
}

function boundedRequestLimit(value) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, MAX_PROVIDER_CONCURRENCY) : MAX_PROVIDER_CONCURRENCY;
}

function notifyQueued(observer, position) {
  try { observer(position); }
  catch { /* Queue observation cannot reject admitted work or retain a phantom slot. */ }
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
