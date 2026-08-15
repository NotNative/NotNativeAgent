// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';

const CACHE_TTL_MS = 300_000;
const MAX_CACHE_ENTRIES = 128;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 3_000;

export class ModelRuntimeRegistry {
  #cache = new Map();
  #pending = new Map();
  #generation = 0;

  constructor(options = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
    this.ttlMs = options.ttlMs ?? CACHE_TTL_MS;
    this.telemetry = options.telemetry;
  }

  async resolve(router, route, signal) {
    assertRoute(route);
    const key = `${route.profile.id}\u0000${route.model}`;
    const cached = this.#cache.get(key);
    if (cached && Date.now() - cached.measuredAt < this.ttlMs) {
      this.#cache.delete(key); this.#cache.set(key, cached);
      return cached;
    }
    const fallback = declaredSnapshot(route, 'declared');
    let pending = this.#pending.get(key);
    if (!pending) {
      const generation = this.#generation;
      pending = this.#discover(router, route, key, fallback, generation)
        .finally(() => { if (this.#pending.get(key) === pending) this.#pending.delete(key); });
      this.#pending.set(key, pending);
    }
    return waitForCaller(pending, signal, fallback);
  }

  async #discover(router, route, key, fallback, generation) {
    const controller = new AbortController();
    let timer;
    try {
      const provider = router.provider(route);
      if (typeof provider.runtimeSnapshot !== 'function') return this.#remember(key, fallback, generation);
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          const error = new Error('model runtime discovery timed out');
          error.code = 'runtime_discovery_timeout';
          reject(error);
        }, this.timeoutMs);
      });
      const found = await Promise.race([provider.runtimeSnapshot(controller.signal), timeout]);
      const snapshot = normalizeSnapshot(route, found);
      this.telemetry?.record('model.runtime_discovery', 'succeeded', snapshot);
      return this.#remember(key, snapshot, generation);
    } catch (error) {
      this.telemetry?.record('model.runtime_discovery', 'failed', {
        provider_profile: route.profile.id, model: route.model,
        failure: { code: error?.code ?? 'runtime_discovery_failed' },
      });
      return this.#remember(key, fallback, generation);
    } finally {
      clearTimeout(timer);
    }
  }

  invalidate() { this.#generation += 1; this.#cache.clear(); this.#pending.clear(); }

  #remember(key, snapshot, generation = this.#generation) {
    const stored = Object.freeze({ ...snapshot, measuredAt: Date.now() });
    if (generation !== this.#generation) return stored;
    if (this.#cache.size >= MAX_CACHE_ENTRIES && !this.#cache.has(key)) {
      this.#cache.delete(this.#cache.keys().next().value);
    }
    this.#cache.delete(key);
    this.#cache.set(key, stored);
    return stored;
  }
}

function normalizeSnapshot(route, value = {}) {
  return Object.freeze({
    providerId: route.profile.id,
    model: route.model,
    contextWindowTokens: positive(value.contextWindowTokens),
    contextLimitBytes: positive(value.contextLimitBytes) ?? positive(route.contextLimitBytes),
    outputLimitTokens: positive(value.outputLimitTokens) ?? positive(route.maxOutputTokens),
    parallelCapacity: positive(value.parallelCapacity),
    source: typeof value.source === 'string' ? value.source : 'provider',
    authoritative: ['lmstudio_v1', 'lmstudio_v0'].includes(value.source),
  });
}

function declaredSnapshot(route, source) {
  return Object.freeze({
    providerId: route.profile.id, model: route.model,
    contextWindowTokens: null,
    contextLimitBytes: positive(route.contextLimitBytes),
    outputLimitTokens: positive(route.maxOutputTokens),
    parallelCapacity: null, source, authoritative: false,
  });
}

function positive(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function assertRoute(route) {
  if (!route?.profile?.id || typeof route.model !== 'string' || route.model.length === 0) {
    throw new ContractError('model_runtime_route_invalid', 'model runtime discovery requires a valid provider route');
  }
}

function waitForCaller(operation, signal, fallback) {
  if (!signal) return operation;
  const cancelled = Object.freeze({ ...fallback, measuredAt: Date.now() });
  if (signal.aborted) return Promise.resolve(cancelled);
  return new Promise((resolve) => {
    const abort = () => { cleanup(); resolve(cancelled); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    operation.then((value) => { cleanup(); resolve(value); }, () => { cleanup(); resolve(cancelled); });
  });
}
