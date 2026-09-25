// SPDX-License-Identifier: Apache-2.0
import { ContractError, newId, requireExternalId } from './ids.js';
import { CanonicalIngress } from './ingress.js';
import { NndSessionRegistry } from './nnd-session-registry.js';
import { childLiveMessage, streamChildDelta } from './nnd-child-stream.js';
import { createWireEventBus } from './opencode/wire-events.js';
import { readFile, stat } from 'node:fs/promises';
import { persistAtomicJson } from './persistence/atomic-json.js';

const CATALOG_LIMIT_BYTES = 1_048_576;
const LIVE_PREVIEW_LIMIT_CHARS = 262_144;

/** Owns NND-created engine contexts; HTTP routing supplies the authenticated principal. */
export class NndEngineHost {
  #contexts = new Map();
  #creating = new Set();
  #childStreams = new Map();
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
    this.eventBus = options.eventBus ?? createWireEventBus();
    this.childSessions = options.childSessions ?? new NndSessionRegistry(options.childSessionLimit ?? 256,
      (type, child, payload) => this.#observeChildEvent(type, child, payload));
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
      engine = await this.createEngine({ ...options, sessionId, nndSessionRegistry: this.childSessions,
        output: (record) => this.observeOutput(sessionId, record) });
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
    const previousTurn = context.liveTurn;
    // Why: ingress can be pending before Engine.submit() exposes its active
    // turn. A second prompt must not replace that turn's output recipient.
    if (previousTurn) {
      if (previousTurn.requestId !== command.request_id) return { accepted: false, reason: 'busy' };
      const repeated = context.ingress.start(command, principal);
      return repeated.duplicate ? repeated.result : { accepted: false, reason: 'busy' };
    }
    // `Engine.submit()` reports a busy turn asynchronously.  A compatibility
    // caller must not receive 204 and confirm its optimistic message when the
    // engine has already rejected that message before the operation settles.
    if (context.engine.active && !context.engine.active.finalized) {
      return { accepted: false, reason: 'busy' };
    }
    const turn = { requestId: command.request_id, activityId: `${sessionId}:turn:${command.request_id}`,
      messageId: `${sessionId}:live:${command.request_id}`, streamedChars: 0, previewLimited: false,
      opened: false, turnId: null, outcome: null };
    context.liveTurn = turn;
    let started;
    try { started = context.ingress.start(command, principal); }
    catch (error) { context.liveTurn = previousTurn; throw error; }
    if (started.duplicate) { context.liveTurn = previousTurn; return started.result; }
    // Why: callers receive the acknowledgement promptly; the engine remains
    // the single owner of turn completion and transcript publication.
    this.#publish(context, 'session.status', { sessionID: sessionId, status: { type: 'busy' } });
    this.#activity(context, turn.activityId, 'turn', 'started', 'Turn started');
    void started.operation.then(
      (result) => this.#publishCompletion(context, turn, result?.accepted === false),
      () => this.#publishCompletion(context, turn, true),
    );
    return { accepted: true, request_id: command.request_id };
  }

  /** Observational engine-output boundary; a display subscriber cannot fail a governed turn. */
  observeOutput(sessionId, record) {
    try {
      const context = this.#contexts.get(sessionId);
      const turn = context?.liveTurn;
      if (!context || context.closing || !turn || record?.session_id !== sessionId) return;
      if (record.turn_id) {
        if (turn.turnId && turn.turnId !== record.turn_id) return;
        turn.turnId ??= record.turn_id;
      }
      if (record.type === 'stream_delta' && typeof record.text === 'string' && record.text.length > 0) {
        const remaining = LIVE_PREVIEW_LIMIT_CHARS - turn.streamedChars;
        const preview = remaining > 0 ? record.text.slice(0, remaining) : '';
        if (preview) {
          const partId = `${turn.messageId}:text`;
          if (!turn.opened) {
            turn.opened = true;
            this.#publish(context, 'message.updated', { sessionID: sessionId, info: {
              id: turn.messageId, sessionID: sessionId, role: 'assistant', time: { created: Date.now() },
              agent: 'nna', model: { providerID: 'nna', modelID: 'nna' },
            } });
            this.#publish(context, 'message.part.updated', { sessionID: sessionId, part: {
              id: partId, sessionID: sessionId, messageID: turn.messageId, type: 'text', text: preview,
            } });
          } else this.#publish(context, 'message.part.delta', { sessionID: sessionId, messageID: turn.messageId,
            partID: partId, field: 'text', delta: preview });
          turn.streamedChars += preview.length;
        }
        if (preview.length < record.text.length && !turn.previewLimited) {
          turn.previewLimited = true;
          this.#activity(context, `${turn.activityId}:preview`, 'notice', 'redacted',
            'Live preview limit reached; the full transcript will appear when the turn completes');
        }
      } else if (record.type === 'tool_status' && typeof record.tool === 'string' && typeof record.status === 'string') {
        const toolId = record.tool_request_id ?? record.provider_call_id;
        if (typeof toolId === 'string' && toolId) {
          const status = activityStatus(record.status);
          this.#activity(context, `${sessionId}:tool:${toolId}`, 'tool', status, `${record.tool}: ${record.status}`);
        }
      } else if (record.type === 'turn_result') {
        turn.outcome = record.outcome;
      }
    } catch { /* Display output is observational, never a reason to fail an engine turn. */ }
  }

  async resolveChildSession(sessionId, principal) {
    requirePrincipal(principal);
    return this.childSessions.resolve(sessionId, principal);
  }

  list(principal, options = {}) {
    requirePrincipal(principal);
    if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) {
      throw new ContractError('request_invalid', 'NND session list limit must be a positive integer');
    }
    const parents = [...this.#contexts.values()].filter((context) => !context.closing && samePrincipal(context, principal)
      && (options.includeArchived === true || !context.archivedAt)).map(describe).sort(sessionIdOrder);
    const visible = new Set(parents.map((session) => session.id));
    const children = (this.childSessions.list?.(principal) ?? []).filter((child) => visible.has(child.parentID)).sort(sessionIdOrder);
    const listed = options.roots === true ? parents : options.roots === false ? children : [...parents, ...children];
    return options.limit === undefined ? listed : listed.slice(0, options.limit);
  }
  listChildren(sessionId, principal) {
    requireExternalId(sessionId, 'session_id'); requirePrincipal(principal);
    this.get(sessionId, principal);
    return (this.childSessions.list?.(principal) ?? []).filter((child) => child.parentID === sessionId).sort(sessionIdOrder);
  }
  get(sessionId, principal) {
    requireExternalId(sessionId, 'session_id'); requirePrincipal(principal);
    if (this.#contexts.has(sessionId)) return describe(this.#owned(sessionId, principal));
    const child = this.childSessions.get?.(sessionId, principal);
    if (child) return child;
    throw new ContractError('nnd_session_unavailable', 'NND session context is unavailable');
  }
  statuses(principal) {
    requirePrincipal(principal);
    const statuses = this.childSessions.statuses?.(principal) ?? {};
    for (const context of this.#contexts.values()) {
      if (!context.closing && samePrincipal(context, principal) && context.engine.active && !context.engine.active.finalized) {
        statuses[context.sessionId] = { type: 'busy' };
      }
    }
    return statuses;
  }
  messages(sessionId, principal) {
    requireExternalId(sessionId, 'session_id'); requirePrincipal(principal);
    if (!this.#contexts.has(sessionId)) {
      const child = this.childSessions.get?.(sessionId, principal);
      const entries = this.childSessions.messages?.(sessionId, principal);
      if (!child || !entries) throw new ContractError('nnd_session_unavailable', 'NND session context is unavailable');
      const messages = entries.map(({ item, index }) => messageProjection({ sessionId, createdAt: child.time.created }, item, index));
      const live = this.#childStreams.get(sessionId);
      if (live?.opened) messages.push(childLiveMessage(child, live));
      return messages;
    }
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

  #publishCompletion(context, turn, rejected) {
    if (context.closing) return;
    if (turn.opened) this.#publish(context, 'message.removed', { sessionID: context.sessionId, messageID: turn.messageId }, true);
    for (const entry of this.messages(context.sessionId, { subjectId: context.subjectId, workspaceIds: [...context.workspaceIds] })) {
      this.#publish(context, 'message.updated', { sessionID: context.sessionId, info: entry.info }, true);
      for (const part of entry.parts) this.#publish(context, 'message.part.updated', { sessionID: context.sessionId, part }, true);
    }
    const result = turnActivity(turn.outcome, rejected);
    this.#activity(context, turn.activityId, 'turn', result.status, result.summary);
    if (context.liveTurn === turn) {
      context.liveTurn = null;
      this.#publish(context, 'session.status', { sessionID: context.sessionId, status: { type: 'idle' } });
      this.#publish(context, 'session.idle', { sessionID: context.sessionId });
    }
    this.#publish(context, 'session.updated', { sessionID: context.sessionId, info: describe(context) }, true);
  }

  #activity(context, id, kind, status, summary) {
    this.#publish(context, 'nnd.activity', { id, sessionID: context.sessionId, kind, status, summary, time: Date.now() });
  }

  #observeChildEvent(type, child, payload) {
    const parent = this.#contexts.get(child.parentID);
    if (!parent) return;
    const state = this.#childStreams.get(child.id);
    if (type === 'registered') {
      this.#childStreams.set(child.id, { messageId: `${child.id}:live`, opened: false, preview: '', streamedChars: 0,
        previewLimited: false, turnId: null, outcome: null });
      this.#publishChild(parent, child, 'session.created', { info: child }, true);
    } else if (type === 'started') {
      this.#publishChild(parent, child, 'session.status', { sessionID: child.id, status: { type: 'busy' } });
      this.#publishChild(parent, child, 'nnd.activity', { id: `${child.id}:turn`, sessionID: child.id,
        kind: 'turn', status: 'started', summary: 'Subagent turn started', time: Date.now() });
    } else if (type === 'output' && state && payload) {
      if (payload.turn_id) {
        if (state.turnId && state.turnId !== payload.turn_id) return;
        state.turnId ??= payload.turn_id;
      }
      if (payload.type === 'stream_delta' && typeof payload.text === 'string' && payload.text) {
        streamChildDelta(child, state, payload.text,
          (eventType, properties) => this.#publishChild(parent, child, eventType, properties));
      } else if (payload.type === 'tool_status' && typeof payload.tool === 'string' && typeof payload.status === 'string') {
        const toolId = payload.tool_request_id ?? payload.provider_call_id;
        if (typeof toolId === 'string' && toolId) this.#publishChild(parent, child, 'nnd.activity', {
          id: `${child.id}:tool:${toolId}`, sessionID: child.id, kind: 'tool', status: activityStatus(payload.status),
          summary: `${payload.tool}: ${payload.status}`, time: Date.now(),
        });
      } else if (payload.type === 'turn_result') state.outcome = payload.outcome;
    } else if (type === 'completed') {
      this.#childStreams.delete(child.id);
      if (state?.opened) this.#publishChild(parent, child, 'message.removed', { sessionID: child.id, messageID: state.messageId }, true);
      const principal = { subjectId: parent.subjectId, workspaceIds: [...parent.workspaceIds] };
      for (const entry of this.messages(child.id, principal)) {
        this.#publishChild(parent, child, 'message.updated', { sessionID: child.id, info: entry.info }, true);
        for (const part of entry.parts) this.#publishChild(parent, child, 'message.part.updated', { sessionID: child.id, part }, true);
      }
      const result = turnActivity(state?.outcome ?? payload?.outcome, false);
      this.#publishChild(parent, child, 'nnd.activity', { id: `${child.id}:turn`, sessionID: child.id,
        kind: 'turn', status: result.status, summary: result.summary, time: Date.now() });
      this.#publishChild(parent, child, 'session.status', { sessionID: child.id, status: { type: 'idle' } });
      this.#publishChild(parent, child, 'session.idle', { sessionID: child.id });
      this.#publishChild(parent, child, 'session.updated', { sessionID: child.id, info: child }, true);
    } else if (type === 'deleted') {
      this.#childStreams.delete(child.id);
      this.#publishChild(parent, child, 'session.deleted', { sessionID: child.id }, true);
    }
  }

  #publishChild(parent, child, type, properties, mirror = false) {
    try { this.eventBus.publishSession({ directory: child.directory, project: parent.workspaceIds.values().next().value,
      subjectId: parent.subjectId, workspaceIds: [...parent.workspaceIds], sessionID: child.id, type, properties, mirror }); }
    catch (error) {
      try { parent.engine.telemetry?.record('nnd.event_delivery', 'failed', { event_type: type,
        code: error?.code ?? 'event_delivery_failed' }); } catch { /* Observational diagnostics cannot fail delegated work. */ }
    }
  }

  #publish(context, type, properties, mirror = false) {
    // Why: a broken display subscriber cannot turn governed work into a false failure.
    try {
      this.eventBus.publishSession({ directory: directoryFor(context), project: context.workspaceIds.values().next().value,
        subjectId: context.subjectId, workspaceIds: [...context.workspaceIds], sessionID: context.sessionId, type, properties, mirror });
    } catch (error) {
      try { context.engine.telemetry?.record('nnd.event_delivery', 'failed', {
        event_type: type, code: error?.code ?? 'event_delivery_failed',
      }); } catch { /* Observational diagnostics cannot replace the engine outcome. */ }
    }
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
function sessionIdOrder(left, right) { return left.id < right.id ? -1 : left.id > right.id ? 1 : 0; }
function titleOf(value) { return typeof value === 'string' && value.trim() && value.length <= 256 ? value.trim() : 'New session'; }
function directoryOf(value) { return typeof value === 'string' && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : ''; }
function directoryFor(context) { return directoryOf(context.engine.config?.workspaceRoot) || context.directory; }
function activityStatus(value) {
  if (value === 'succeeded' || value === 'duplicate_ignored') return 'completed';
  if (value === 'review_pending' || value === 'approved' || value === 'running') return 'started';
  return 'failed';
}
function turnActivity(outcome, rejected) {
  if (rejected) return { status: 'failed', summary: 'Turn failed' };
  if (outcome === 'cancelled') return { status: 'completed', summary: 'Turn cancelled' };
  if (outcome === 'needs_input') return { status: 'completed', summary: 'Turn needs input' };
  if (outcome && outcome !== 'completed') return { status: 'failed', summary: 'Turn failed' };
  return { status: 'completed', summary: 'Turn completed' };
}
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
