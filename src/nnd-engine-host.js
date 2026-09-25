// SPDX-License-Identifier: Apache-2.0
import { ContractError, newId, requireExternalId } from './ids.js';
import { CanonicalIngress } from './ingress.js';
import { NndSessionRegistry } from './nnd-session-registry.js';

/** Owns NND-created engine contexts; HTTP routing supplies the authenticated principal. */
export class NndEngineHost {
  #contexts = new Map();
  #creating = new Set();
  constructor(options = {}) {
    if (typeof options.createEngine !== 'function') {
      throw new ContractError('nnd_engine_factory_missing', 'NND engine host requires an engine factory');
    }
    const limit = options.limit ?? 64;
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new ContractError('nnd_context_capacity_invalid', 'NND engine context capacity must be a positive integer');
    }
    this.createEngine = options.createEngine;
    this.limit = limit;
    this.childSessions = options.childSessions ?? new NndSessionRegistry(options.childSessionLimit ?? 256);
  }

  async create(sessionId, principal, options = {}) {
    requireExternalId(sessionId, 'session_id');
    requirePrincipal(principal);
    if (this.#contexts.has(sessionId) || this.#creating.has(sessionId)) {
      throw new ContractError('nnd_session_exists', 'NND session context already exists');
    }
    if (this.#contexts.size + this.#creating.size >= this.limit) {
      throw new ContractError('nnd_context_capacity', 'NND engine context capacity is full');
    }
    this.#creating.add(sessionId);
    let engine;
    try {
      engine = await this.createEngine({ ...options, sessionId, nndSessionRegistry: this.childSessions });
      if (!engine || typeof engine.initialize !== 'function') {
        throw new ContractError('nnd_engine_invalid', 'NND engine factory returned an invalid engine');
      }
      await engine.initialize();
      const context = { sessionId, subjectId: principal.subjectId, workspaceIds: new Set(principal.workspaceIds), engine,
        title: titleOf(options.title), directory: directoryOf(options.directory), createdAt: Date.now(),
        ingress: new CanonicalIngress(engine, { interactive: options.interactive === true }), closing: false };
      this.#contexts.set(sessionId, context);
      return context;
    } catch (error) {
      // Why: an engine can acquire resources before initialization reports its failure.
      await shutdownAfterFailedCreate(engine);
      throw error;
    } finally {
      this.#creating.delete(sessionId);
    }
  }

  async submit(sessionId, command, principal) {
    const context = this.#owned(sessionId, principal);
    return context.ingress.submit(command, principal);
  }

  submitAsync(sessionId, command, principal) {
    const context = this.#owned(sessionId, principal);
    // `Engine.submit()` reports a busy turn asynchronously.  A compatibility
    // caller must not receive 204 and confirm its optimistic message when the
    // engine has already rejected that message before the operation settles.
    if (context.engine.active && !context.engine.active.finalized) {
      return { accepted: false, reason: 'busy' };
    }
    const started = context.ingress.start(command, principal);
    if (started.duplicate) return started.result;
    // Why: callers receive the acknowledgement promptly; the engine remains
    // the single owner of turn completion and transcript publication.
    void started.operation.catch(() => undefined);
    return { accepted: true, request_id: command.request_id };
  }

  async resolveChildSession(sessionId, principal) {
    requirePrincipal(principal);
    return this.childSessions.resolve(sessionId, principal);
  }

  list(principal) { requirePrincipal(principal); return [...this.#contexts.values()].filter((context) => !context.closing && samePrincipal(context, principal)).map(describe); }
  get(sessionId, principal) { return describe(this.#owned(sessionId, principal)); }
  statuses(principal) {
    requirePrincipal(principal);
    const statuses = {};
    for (const context of this.#contexts.values()) {
      if (!context.closing && samePrincipal(context, principal) && context.engine.active && !context.engine.active.finalized) {
        statuses[context.sessionId] = { type: 'busy' };
      }
    }
    return statuses;
  }
  messages(sessionId, principal) {
    const context = this.#owned(sessionId, principal);
    return context.engine.transcript
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item?.type === 'message' && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string')
      .slice(-200)
      .map(({ item, index }) => messageProjection(context, item, index));
  }

  async close(sessionId, principal) {
    const context = this.#owned(sessionId, principal, true);
    context.closing = true;
    // Security: closing a parent revokes its child steering grants before shutdown can fail.
    this.childSessions.unregisterParent?.(sessionId);
    await context.engine.shutdown({ version: '1.0', type: 'shutdown', request_id: newId('nnd_close') });
    this.#contexts.delete(sessionId);
    return { closed: true };
  }

  #owned(sessionId, principal, allowClosing = false) {
    requireExternalId(sessionId, 'session_id');
    requirePrincipal(principal);
    const context = this.#contexts.get(sessionId);
    if (!context || context.closing && !allowClosing || !samePrincipal(context, principal)) {
      throw new ContractError('nnd_session_unavailable', 'NND session context is unavailable');
    }
    return context;
  }
}

function messageProjection(context, item, index) {
  // Transcript positions are monotonic for an engine lifetime.  Keeping that
  // position in the public ID prevents old pages from changing identity as the
  // bounded NND projection rolls forward.
  const messageId = `${context.sessionId}:message:${index}`;
  return { info: { id: messageId, sessionID: context.sessionId, role: item.role, time: { created: context.createdAt + index }, agent: 'nna', model: { providerID: 'nna', modelID: 'nna' } }, parts: [{ id: `${context.sessionId}:part:${index}`, sessionID: context.sessionId, messageID: messageId, type: 'text', text: item.content }] };
}

function requirePrincipal(principal) {
  if (!principal || typeof principal.subjectId !== 'string' || !principal.subjectId.trim()
    || !Array.isArray(principal.workspaceIds) || principal.workspaceIds.length === 0
    || principal.workspaceIds.some((id) => typeof id !== 'string' || !id.trim())) {
    throw new ContractError('nnd_principal_invalid', 'NND engine context requires an authenticated principal');
  }
}

function samePrincipal(context, principal) {
  // A later principal with only one overlapping workspace must not regain a
  // context that was created under a broader workspace grant.
  return context.subjectId === principal.subjectId && [...context.workspaceIds].every((id) => principal.workspaceIds.includes(id));
}
function describe(context) { return { id: context.sessionId, slug: context.sessionId, projectID: context.workspaceIds.values().next().value, directory: context.directory, title: context.title, version: '1.0', tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: context.createdAt, updated: context.createdAt } }; }
function titleOf(value) { return typeof value === 'string' && value.trim() && value.length <= 256 ? value.trim() : 'New session'; }
function directoryOf(value) { return typeof value === 'string' && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : ''; }

async function shutdownAfterFailedCreate(engine) {
  if (!engine || typeof engine.shutdown !== 'function') return;
  try {
    await engine.shutdown({ version: '1.0', type: 'shutdown', request_id: newId('nnd_initialize_failed') });
  } catch { /* preserve the initialization failure as the causal error */ }
}
