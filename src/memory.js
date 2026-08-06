// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { ContractError, newId } from './ids.js';

export class MemoryBoundary {
  #generation = 0;

  constructor(config, adapter = null, options = {}) {
    this.config = config;
    this.adapter = adapter;
    this.grounding = options.grounding ?? null;
  }

  get enabled() {
    return this.config.enabled && this.adapter !== null;
  }

  async recall(text, projectRoot, signal) {
    if (!this.enabled) return Object.freeze({ status: 'disabled', items: [] });
    const generation = ++this.#generation;
    const scope = projectScope(projectRoot);
    const query = boundedQuery(text);
    const requestId = newId('memory_request');
    try {
      const raw = await boundedCall(
        (boundedSignal) => this.adapter.query({ requestId, query, scope, limit: this.config.maxItems, signal: boundedSignal }),
        this.config.timeoutMs, signal,
      );
      if (generation !== this.#generation || signal?.aborted) return { status: 'late_discarded', items: [], requestId };
      const normalized = normalizeItems(raw, scope, this.config);
      const governed = this.grounding
        ? await this.grounding.admitMemory(normalized, { requestId, authorityRef: 'authenticated_submission' })
        : { admitted: normalized, rejected: [] };
      return { status: 'ready', items: governed.admitted, rejected: governed.rejected, requestId };
    } catch (error) {
      if (this.config.required) throw error;
      return { status: 'degraded', items: [], reason: error.code ?? 'memory_unavailable', requestId };
    }
  }

  async saveExplicit(content, projectRoot, options = {}) {
    if (!this.enabled) throw new ContractError('memory_disabled', 'memory is not enabled');
    if (typeof content !== 'string' || content.length === 0 || Buffer.byteLength(content) > 131_072) {
      throw new ContractError('memory_content_invalid', 'memory content must be bounded non-empty text');
    }
    if (containsSecret(content)) throw new ContractError('memory_secret_rejected', 'secret-like content cannot be saved');
    if (options.id !== undefined && options.expectedVersion === undefined) {
      throw new ContractError('memory_version_required', 'updating an existing memory requires its expected version');
    }
    const record = {
      id: options.id ?? newId('memory'), scope: projectScope(projectRoot), content,
      pinned: options.pinned === true, expectedVersion: options.expectedVersion ?? null,
      idempotencyKey: options.idempotencyKey ?? createHash('sha256').update(content).digest('hex'),
    };
    const requestId = newId('memory_request');
    return boundedCall((signal) => this.adapter.save({ ...record, requestId }, signal), this.config.timeoutMs);
  }

  automaticCandidate(content, projectRoot) {
    if (!this.enabled || typeof content !== 'string' || content.length === 0 || containsSecret(content)) return null;
    return Object.freeze({
      id: newId('memory_candidate'), scope: projectScope(projectRoot), content,
      status: 'candidate', requiresConfirmation: true,
    });
  }

  async inspect(projectRoot) {
    if (!this.enabled) return [];
    const requestId = newId('memory_request');
    return boundedCall((signal) => this.adapter.inspect(projectScope(projectRoot), { requestId, signal }), this.config.timeoutMs);
  }

  delete(id, projectRoot, expectedVersion = null) {
    if (!this.enabled) throw new ContractError('memory_disabled', 'memory is not enabled');
    const requestId = newId('memory_request');
    return boundedCall((signal) => this.adapter.delete({
      id, scope: projectScope(projectRoot), expectedVersion, requestId, signal,
    }), this.config.timeoutMs);
  }

  health() {
    if (!this.config.enabled) return Promise.resolve({ status: 'disabled', reason: 'configuration_disabled' });
    if (this.adapter === null) return Promise.resolve({ status: 'unavailable', reason: 'adapter_unavailable' });
    const requestId = newId('memory_request');
    return boundedCall((signal) => this.adapter.health({ requestId, signal }), this.config.timeoutMs);
  }
}

function normalizeItems(value, scope, config) {
  if (!Array.isArray(value)) throw new ContractError('memory_malformed', 'memory query returned malformed data');
  const items = value.map(validateItem).filter((item) => item.scope === scope || item.scope === 'user');
  items.sort(compareItems);
  const result = [];
  let bytes = 0;
  for (const item of items.slice(0, config.maxItems)) {
    const size = Buffer.byteLength(JSON.stringify(item), 'utf8');
    if (bytes + size > config.maxBytes) break;
    result.push(Object.freeze(item));
    bytes += size;
  }
  return Object.freeze(result);
}

function validateItem(item) {
  if (!item || typeof item !== 'object' || typeof item.id !== 'string'
    || typeof item.scope !== 'string' || typeof item.content !== 'string') {
    throw new ContractError('memory_malformed', 'memory item lacks required attribution');
  }
  return {
    id: item.id, scope: item.scope, content: item.content.slice(0, 65_536),
    relevance: number(item.relevance ?? item.confidence), pinned: item.pinned === true,
    createdAt: number(item.createdAt), updatedAt: number(item.updatedAt),
    source: typeof item.source === 'string' ? item.source : 'memory_adapter',
    stale: item.stale === true, conflict: item.conflict === true,
    labels: Object.freeze([
      ...(item.stale === true ? ['stale'] : []), ...(item.conflict === true ? ['conflict'] : []),
    ]),
  };
}

function compareItems(left, right) {
  return Number(right.pinned) - Number(left.pinned)
    || scopeSpecificity(right.scope) - scopeSpecificity(left.scope)
    || right.relevance - left.relevance
    || right.updatedAt - left.updatedAt
    || left.id.localeCompare(right.id);
}

function scopeSpecificity(scope) { return scope.startsWith('project:') ? 2 : scope === 'user' ? 1 : 0; }

function boundedQuery(text) {
  return redactSecrets(String(text)).slice(0, 4096);
}

function containsSecret(text) {
  return /(?:bearer\s+[A-Za-z0-9._-]{16,}|api[_-]?key\s*[=:]\s*\S+|-----BEGIN [A-Z ]+PRIVATE KEY-----)/iu.test(text);
}

function redactSecrets(text) {
  return text
    .replaceAll(/(?:bearer\s+|api[_-]?key\s*[=:]\s*)\S+/giu, '[redacted]')
    .replaceAll(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/gu, '[redacted private key]');
}

function projectScope(root) {
  return `project:${createHash('sha256').update(root).digest('hex')}`;
}

function number(value) {
  return Number.isFinite(value) ? value : 0;
}

async function boundedCall(operation, timeoutMs, parentSignal = null) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parentSignal?.addEventListener('abort', abort, { once: true });
  if (parentSignal?.aborted) controller.abort();
  let deadlineExpired = false;
  const timer = setTimeout(() => { deadlineExpired = true; abort(); }, timeoutMs);
  const cancelled = new Promise((_, reject) => {
    const rejectAbort = () => reject(deadlineExpired
      ? new ContractError('memory_timeout', 'memory operation exceeded its deadline', true)
      : new ContractError('memory_cancelled', 'memory operation was cancelled'));
    if (controller.signal.aborted) rejectAbort();
    else controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  try {
    return await Promise.race([
      operation(controller.signal),
      cancelled,
    ]);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abort);
  }
}
