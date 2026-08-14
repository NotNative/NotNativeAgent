// SPDX-License-Identifier: Apache-2.0

const CACHE_TTL_MS = 300_000;
const MAX_CACHE_ENTRIES = 128;

export class ModelRuntimeRegistry {
  #cache = new Map();

  constructor(options = {}) {
    this.timeoutMs = options.timeoutMs ?? 3_000;
    this.ttlMs = options.ttlMs ?? CACHE_TTL_MS;
    this.telemetry = options.telemetry;
  }

  async resolve(router, route, signal) {
    const key = `${route.profile.id}\u0000${route.model}`;
    const cached = this.#cache.get(key);
    if (cached && Date.now() - cached.measuredAt < this.ttlMs) return cached;
    const fallback = declaredSnapshot(route, 'declared');
    const provider = router.provider(route);
    if (typeof provider.runtimeSnapshot !== 'function') return this.#remember(key, fallback);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    let timer;
    try {
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
      return this.#remember(key, snapshot);
    } catch (error) {
      this.telemetry?.record('model.runtime_discovery', 'failed', {
        provider_profile: route.profile.id, model: route.model,
        failure: { code: error?.code ?? 'runtime_discovery_failed' },
      });
      return this.#remember(key, fallback);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      controller.abort();
    }
  }

  invalidate() { this.#cache.clear(); }

  #remember(key, snapshot) {
    if (this.#cache.size >= MAX_CACHE_ENTRIES && !this.#cache.has(key)) {
      this.#cache.delete(this.#cache.keys().next().value);
    }
    const stored = Object.freeze({ ...snapshot, measuredAt: Date.now() });
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
