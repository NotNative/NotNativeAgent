// SPDX-License-Identifier: Apache-2.0
import { ContractError, newId, requireExternalId } from './ids.js';
import { CanonicalIngress } from './ingress.js';
import { NndSessionRegistry } from './nnd-session-registry.js';
import { createWireEventBus } from './opencode/wire-events.js';
import { readFile, stat } from 'node:fs/promises';
import { persistAtomicJson } from './persistence/atomic-json.js';

const CATALOG_LIMIT_BYTES = 1_048_576;

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
    this.eventBus = options.eventBus ?? createWireEventBus();
    this.catalogPath = options.catalogPath ?? null;
    this.persistCatalog = options.persistCatalog ?? persistAtomicJson;
    this.catalogWrites = Promise.resolve();
  }

  async initialize() {
    if (!this.catalogPath) return;
    let source;
    try {
      const metadata = await stat(this.catalogPath);
      if (!metadata.isFile() || metadata.size > CATALOG_LIMIT_BYTES) throw new Error('catalog bound');
      source = await readFile(this.catalogPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw new ContractError('nnd_catalog_unavailable', 'NND session catalog is unavailable', { cause: error });
    }
    let records;
    try { records = JSON.parse(source); } catch { throw new ContractError('nnd_catalog_invalid', 'NND session catalog is invalid'); }
    if (!Array.isArray(records) || records.length > this.limit) throw new ContractError('nnd_catalog_invalid', 'NND session catalog is invalid');
    try {
      for (const record of records) {
        if (!validCatalogRecord(record)) throw new ContractError('nnd_catalog_invalid', 'NND session catalog is invalid');
        await this.#createContext(record.sessionId, { subjectId: record.subjectId, workspaceIds: record.workspaceIds }, {
          title: record.title, directory: record.directory, createdAt: record.createdAt,
          updatedAt: record.updatedAt ?? record.createdAt, archivedAt: record.archivedAt ?? 0,
        }, true);
      }
    } catch (error) {
      await this.shutdown().catch(() => undefined);
      throw error;
    }
  }

  async create(sessionId, principal, options = {}) {
    return this.#createContext(sessionId, principal, options, false);
  }

  async #createContext(sessionId, principal, options, restoring) {
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
      const createdAt = restoring ? options.createdAt : Date.now();
      const context = { sessionId, subjectId: principal.subjectId, workspaceIds: new Set(principal.workspaceIds), engine,
        title: titleOf(options.title), directory: directoryOf(engine.config?.workspaceRoot) || directoryOf(options.directory), createdAt,
        updatedAt: restoring ? options.updatedAt : createdAt,
        archivedAt: restoring ? options.archivedAt : 0,
        ingress: new CanonicalIngress(engine, { interactive: options.interactive === true }), closing: false };
      if (restoring) this.#contexts.set(sessionId, context);
      else await this.#commitCatalogChange(
        (contexts) => contexts.set(sessionId, context),
        () => this.#contexts.set(sessionId, context),
      );
      if (!restoring) this.#publish(context, 'session.created', { info: describe(context) }, true);
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

  async abort(sessionId, principal) {
    const context = this.#owned(sessionId, principal);
    return context.ingress.submit({ version: '1.0', type: 'cancel', request_id: newId('nnd_abort') }, principal);
  }

  async rename(sessionId, principal, value) {
    const context = this.#owned(sessionId, principal);
    if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new ContractError('session_name_invalid', 'NND session title must be bounded printable text');
    }
    const title = value.trim();
    let updatedAt;
    await this.#commitCatalogChange(
      (contexts) => {
        if (context.closing || contexts.get(sessionId) !== context) {
          throw new ContractError('nnd_session_unavailable', 'NND session context is unavailable');
        }
        updatedAt = nextUpdatedAt(context);
        contexts.set(sessionId, { ...context, title, updatedAt });
      },
      () => { context.title = title; context.updatedAt = updatedAt; },
    );
    this.#publish(context, 'session.updated', { sessionID: sessionId, info: describe(context) }, true);
    return describe(context);
  }

  async setArchived(sessionId, principal, value) {
    const context = this.#owned(sessionId, principal);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ContractError('request_invalid', 'NND archived time must be a nonnegative timestamp');
    }
    let updatedAt;
    await this.#commitCatalogChange(
      (contexts) => {
        if (context.closing || contexts.get(sessionId) !== context) {
          throw new ContractError('nnd_session_unavailable', 'NND session context is unavailable');
        }
        updatedAt = nextUpdatedAt(context);
        contexts.set(sessionId, { ...context, archivedAt: value, updatedAt });
      },
      () => { context.archivedAt = value; context.updatedAt = updatedAt; },
    );
    this.#publish(context, 'session.updated', { sessionID: sessionId, info: describe(context) }, true);
    return describe(context);
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
    this.#publish(context, 'session.status', { sessionID: sessionId, status: { type: 'busy' } });
    void started.operation.then(
      () => this.#publishCompletion(context),
      () => this.#publishCompletion(context),
    );
    return { accepted: true, request_id: command.request_id };
  }

  async resolveChildSession(sessionId, principal) {
    requirePrincipal(principal);
    return this.childSessions.resolve(sessionId, principal);
  }

  list(principal, options = {}) { requirePrincipal(principal); return [...this.#contexts.values()].filter((context) => !context.closing && samePrincipal(context, principal) && (options.includeArchived === true || !context.archivedAt)).map(describe); }
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
    await this.#commitCatalogChange(
      (contexts) => contexts.delete(sessionId),
      () => this.#contexts.delete(sessionId),
    );
    this.#publish(context, 'session.deleted', { sessionID: sessionId }, true);
    return { closed: true };
  }

  async shutdown() {
    const contexts = [...this.#contexts.values()];
    const settled = await Promise.allSettled(contexts.map((context) => context.engine.shutdown({
      version: '1.0', type: 'shutdown', request_id: newId('nnd_shutdown'),
    })));
    const failed = settled.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
  }

  async #commitCatalogChange(change, commit) {
    if (!this.catalogPath) { change(new Map(this.#contexts)); commit(); return; }
    // Keep the durable write and its in-memory commit in one serialized unit.
    // A failed create must not be included in another creator's snapshot.
    const transaction = this.catalogWrites.catch(() => undefined).then(async () => {
      const candidate = new Map(this.#contexts);
      change(candidate);
      const records = [...candidate.values()].map((context) => ({
        sessionId: context.sessionId, subjectId: context.subjectId, workspaceIds: [...context.workspaceIds],
        title: context.title, directory: directoryFor(context), createdAt: context.createdAt,
        updatedAt: context.updatedAt, archivedAt: context.archivedAt,
      }));
      if (Buffer.byteLength(`${JSON.stringify(records, null, 2)}\n`, 'utf8') > CATALOG_LIMIT_BYTES) {
        throw new ContractError('nnd_catalog_capacity', 'NND session catalog capacity is full');
      }
      await this.persistCatalog(this.catalogPath, records);
      commit();
    });
    this.catalogWrites = transaction;
    await transaction;
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

  #publishCompletion(context) {
    if (context.closing) return;
    for (const entry of this.messages(context.sessionId, { subjectId: context.subjectId, workspaceIds: [...context.workspaceIds] })) {
      this.#publish(context, 'message.updated', { sessionID: context.sessionId, info: entry.info }, true);
      for (const part of entry.parts) this.#publish(context, 'message.part.updated', { sessionID: context.sessionId, part }, true);
    }
    this.#publish(context, 'session.status', { sessionID: context.sessionId, status: { type: 'idle' } });
    this.#publish(context, 'session.idle', { sessionID: context.sessionId });
    this.#publish(context, 'session.updated', { sessionID: context.sessionId, info: describe(context) }, true);
  }

  #publish(context, type, properties, mirror = false) {
    this.eventBus.publishSession({ directory: directoryFor(context), project: context.workspaceIds.values().next().value,
      subjectId: context.subjectId, sessionID: context.sessionId, type, properties, mirror });
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
function describe(context) { return { id: context.sessionId, slug: context.sessionId, projectID: context.workspaceIds.values().next().value, directory: directoryFor(context), title: context.title, version: '1.0', tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: context.createdAt, updated: context.updatedAt, ...(context.archivedAt ? { archived: context.archivedAt } : {}) } }; }
function nextUpdatedAt(context) { return Math.max(Date.now(), context.updatedAt + 1); }
function titleOf(value) { return typeof value === 'string' && value.trim() && value.length <= 256 ? value.trim() : 'New session'; }
function directoryOf(value) { return typeof value === 'string' && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : ''; }
function directoryFor(context) { return directoryOf(context.engine.config?.workspaceRoot) || context.directory; }
function validCatalogRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  try { requireExternalId(record.sessionId, 'session_id'); requirePrincipal(record); }
  catch { return false; }
  return typeof record.title === 'string' && record.title.length <= 256 && typeof record.directory === 'string'
    && record.directory.length <= 4096 && Number.isSafeInteger(record.createdAt) && record.createdAt > 0
    && (record.updatedAt === undefined || Number.isSafeInteger(record.updatedAt) && record.updatedAt >= record.createdAt)
    && (record.archivedAt === undefined || Number.isSafeInteger(record.archivedAt) && record.archivedAt >= 0);
}

async function shutdownAfterFailedCreate(engine) {
  if (!engine || typeof engine.shutdown !== 'function') return;
  try {
    await engine.shutdown({ version: '1.0', type: 'shutdown', request_id: newId('nnd_initialize_failed') });
  } catch { /* preserve the initialization failure as the causal error */ }
}
