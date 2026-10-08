// SPDX-License-Identifier: Apache-2.0
import { ContractError, newId, requireExternalId } from './ids.js';
import { CanonicalIngress } from './ingress.js';
import { NndSessionRegistry } from './nnd-session-registry.js';
import { activityStatus, childLiveMessage, observeChildLifecycle, publishNndChildEvent, turnActivity } from './nnd-child-stream.js';
import { hasPersistedSubmission, messageProjection, reservedProjectedMessageId } from './nnd-transcript-identity.js';
import { nndContextObservation } from './nnd-context-observation.js';
import { observeNndSessionState } from './nnd-turn-state.js';
import { NndActiveTools } from './nnd-active-tools.js';
import { observeNndPhaseActivity } from './nnd-phase-activity.js';
import { parentChildActivity } from './nnd-parent-child-activity.js';
import { describe, nextUpdatedAt, sessionIdOrder, titleOf, directoryOf, directoryFor } from './nnd-session-description.js';
import { createWireEventBus } from './opencode/wire-events.js';
import { readFile, stat } from 'node:fs/promises';
import { persistAtomicJson } from './persistence/atomic-json.js';
import { appendActivity, drainActivityWrites, loadActivity, removeActivity, reportActivityFailure, scheduleActivityWrite } from './nnd-activity-snapshot.js';
import { readActivityPageWithBoundary } from './nnd-activity-boundary.js';
import { NndActivityTombstones } from './nnd-activity-tombstones.js';
import { enqueueNndCatalogChange } from './nnd-catalog-transaction.js';
import { loadChildSnapshots, NndChildSnapshotStore } from './nnd-child-snapshot.js';
import { validatedNndGoal, commitNndGoal } from './nnd-goal.js';
import { nndGoalContextEvidence, recordNndGoalTurn } from './nnd-goal-evidence.js';
import { runNndGoalAudit } from './nnd-goal-audit.js';
import { runNndWalkthrough } from './nnd-walkthrough.js';
import { runNndNotification } from './nnd-notification.js';
import { publishNndProjection } from './nnd-projection.js';
import { reviewModeSnapshot, commitReviewMode } from './nnd-review-mode.js';
import { ownedPendingRequests } from './nnd-pending-requests.js';
import { listNndQuestions, settleNndQuestion, observeNndQuestion } from './nnd-questions.js';
import { requirePrincipal, samePrincipal, scopedPrincipal, validCatalogRecord, restoreNndContexts, shutdownAfterFailedCreate } from './nnd-session-helpers.js';
import { partitionNndCatalog } from './nnd-catalog-admission.js';
import { resolveContextBinding, initializeBoundEngine,
  assertLiveNndWorkspaceBinding } from './nnd-workspace-binding.js';
import { NndWorkspaceRevocationGuard } from './nnd-workspace-revocation-guard.js';
import { listNndSessions, nndSessionStatuses } from './nnd-session-list.js';
const CATALOG_LIMIT_BYTES = 1_048_576, LIVE_PREVIEW_LIMIT_CHARS = 262_144;
/** Owns NND-created engine contexts; HTTP routing supplies the authenticated principal. */
export class NndEngineHost {
  #contexts = new Map();
  #creating = new Set();
  #deleting = new Set();
  #childStreams = new Map();
  #childActivity = new Map();
  #quarantined = [];
  #workspaceRevocations = new NndWorkspaceRevocationGuard();
  constructor(options = {}) {
    if (typeof options.createEngine !== 'function') {
      throw new ContractError('nnd_engine_factory_missing', 'NND engine host requires an engine factory');
    }
    const limit = options.limit ?? 64;
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new ContractError('nnd_context_capacity_invalid', 'NND engine context capacity must be a positive integer');
    }
    this.createEngine = options.createEngine; this.primaryWorkspaceBinding = options.primaryWorkspaceBinding ?? null;
    this.limit = limit;
    this.eventBus = options.eventBus ?? createWireEventBus();
    this.childSessions = options.childSessions ?? new NndSessionRegistry(options.childSessionLimit ?? 256,
      (type, child, payload) => this.#observeChildEvent(type, child, payload));
    this.catalogPath = options.catalogPath ?? null;
    this.tombstones = new NndActivityTombstones(this.catalogPath, options.persistTombstones);
    this.persistCatalog = options.persistCatalog ?? persistAtomicJson;
    this.persistActivity = options.persistActivity ?? persistAtomicJson;
    this.childSnapshotStore = new NndChildSnapshotStore(this.catalogPath, options.persistChildSnapshot);
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
      const { restorable, quarantined } = await partitionNndCatalog(records, this.primaryWorkspaceBinding, validCatalogRecord);
      this.#quarantined = quarantined;
      await restoreNndContexts(restorable, (sessionId, principal, options) => this.#createContext(sessionId, principal, options, true));
      for (const snapshot of await loadChildSnapshots(this.catalogPath, this.#contexts, this.childSessions.limit ?? 256)) {
        this.childSessions.restoreCompleted?.(snapshot);
        this.#childActivity.set(snapshot.sessionId, snapshot.activity);
      }
      if (this.primaryWorkspaceBinding && records.some(record => record.workspaceBinding === undefined)) await this.#commitCatalogChange(() => {}, () => {});
    } catch (error) {
      await this.shutdown().catch(() => undefined);
      throw error;
    }
  }
  async create(sessionId, principal, options = {}) { return this.#createContext(sessionId, principal, options, false); }
  async #createContext(sessionId, principal, options, restoring) {
    requireExternalId(sessionId, 'session_id');
    requirePrincipal(principal);
    if (this.#contexts.has(sessionId) || this.#creating.has(sessionId) || this.#deleting.has(sessionId)) {
      throw new ContractError('nnd_session_exists', 'NND session context already exists');
    }
    if (this.#contexts.size + this.#quarantined.length + this.#creating.size >= this.limit) {
      throw new ContractError('nnd_context_capacity', 'NND engine context capacity is full');
    }
    this.#creating.add(sessionId);
    let engine;
    try {
      if (!restoring) await this.tombstones.beforeCreate(sessionId, principal, this.#contexts);
      if (!restoring) await removeActivity(this.catalogPath, sessionId); // Remove a crash-left prior incarnation.
      const binding = await resolveContextBinding(this.primaryWorkspaceBinding, principal, options, restoring);
      if (this.#workspaceRevocations.has(binding)) {
        throw new ContractError('nnd_workspace_in_use', 'Workspace admission is being revoked.');
      }
      engine = await this.createEngine({ ...options, sessionId, nndSessionRegistry: this.childSessions,
        workspaceBinding: binding, workspaceBindingResolver: this.primaryWorkspaceBinding,
        output: (record) => this.observeOutput(sessionId, record) });
      if (!engine || typeof engine.initialize !== 'function') {
        throw new ContractError('nnd_engine_invalid', 'NND engine factory returned an invalid engine');
      }
      await initializeBoundEngine(engine, this.primaryWorkspaceBinding, binding, principal, options, restoring);
      if (restoring) engine.reviewPosture = options.reviewMode === 'unattended' ? 'unattended' : 'auto-review';
      const createdAt = restoring ? options.createdAt : Date.now();
      const activity = restoring ? await loadActivity(this.catalogPath, sessionId, createdAt) : [];
      const context = { sessionId, subjectId: principal.subjectId,
        workspaceIds: new Set(binding ? [binding.id] : principal.workspaceIds), engine,
        ...(binding ? { workspaceBinding: binding } : {}),
        title: titleOf(options.title), directory: directoryOf(engine.config?.workspaceRoot) || directoryOf(options.directory), createdAt,
        updatedAt: restoring ? options.updatedAt : createdAt, contextUsage: restoring ? options.contextUsage : null,
        goal: restoring && options.goal ? validatedNndGoal(options.goal) : null,
        goalRevision: restoring ? options.goalRevision : 0, goalTurnReceipts: [], goalTurnReceiptsTruncated: false,
        archivedAt: restoring ? options.archivedAt : 0, activity, activityRevision: 0, activityWrite: null,
        ingress: new CanonicalIngress(engine, { interactive: options.interactive === true, questions: Boolean(engine.questionBroker) }), closing: false, goalArming: 0,
        reviewMode: options.reviewMode ?? 'default', reviewRevision: options.reviewRevision ?? 0, reviewArming: 0 };
      if (restoring) this.#contexts.set(sessionId, context);
      else {
        if (this.#workspaceRevocations.has(binding)) {
          throw new ContractError('nnd_workspace_in_use', 'Workspace admission is being revoked.');
        }
        await this.#commitCatalogChange(
        (contexts) => contexts.set(sessionId, context),
        () => this.#contexts.set(sessionId, context),
        );
      }
      if (!restoring) this.#publish(context, 'session.created', { info: describe(context) }, true);
      return context;
    } catch (error) {
      // Why: an engine can acquire resources before initialization reports its failure.
      await shutdownAfterFailedCreate(engine, error);
      throw error;
    } finally {
      this.#creating.delete(sessionId);
    }
  }
  async submit(sessionId, command, principal) {
    await this.assertWorkspaceBound(sessionId, principal);
    const context = this.#owned(sessionId, principal);
    if (context.reviewArming > 0) throw new ContractError('nnd_session_unavailable', 'review mode change is pending');
    return context.ingress.submit(command, scopedPrincipal(context, principal));
  }
  async assertWorkspaceBound(sessionId, principal) {
    const context = this.#owned(sessionId, principal);
    await assertLiveNndWorkspaceBinding(context, this.primaryWorkspaceBinding, principal,
      () => this.#owned(sessionId, principal));
  }
  reviewMode(sessionId, principal) { return reviewModeSnapshot(this.#owned(sessionId, principal)); }
  setReviewMode(sessionId, principal, body) {
    const context = this.#owned(sessionId, principal);
    return commitReviewMode(context, body, (change, commit) => this.#commitCatalogChange(change, commit),
      () => this.#publish(context, 'session.updated', { sessionID: sessionId, info: describe(context) }, true));
  }
  async abort(sessionId, principal) {
    const context = this.#owned(sessionId, principal);
    return context.ingress.submit({ version: '1.0', type: 'cancel', request_id: newId('nnd_abort') }, scopedPrincipal(context, principal));
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
  goal(sessionId, principal) { const context = this.#owned(sessionId, principal); return { goal: context.goal, revision: context.goalRevision }; }
  auditGoal(sessionId, principal, body) { return runNndGoalAudit(this.#owned(sessionId, principal), body); }
  generateWalkthrough(sessionId, principal, body) { return runNndWalkthrough(this.#owned(sessionId, principal), body); }
  generateNotification(sessionId, principal, body) { return runNndNotification(this.#owned(sessionId, principal), body); }
  goalEvidence(sessionId, principal) { return nndGoalContextEvidence(this.#owned(sessionId, principal)); }
  async setGoal(sessionId, principal, value, expectedId, expectedRevision) {
    const goal = validatedNndGoal(value);
    return this.#writeGoal(sessionId, principal, goal, expectedId, expectedRevision);
  }
  async clearGoal(sessionId, principal, expectedId, expectedRevision) {
    return this.#writeGoal(sessionId, principal, null, expectedId, expectedRevision);
  }
  async #writeGoal(sessionId, principal, goal, expectedId, expectedRevision) {
    const context = this.#owned(sessionId, principal);
    return commitNndGoal(context, sessionId, goal, expectedId, expectedRevision,
      (change, commit) => this.#commitCatalogChange(change, commit), (...args) => this.#publish(...args));
  }
  submitAsync(sessionId, command, principal) {
    const context = this.#owned(sessionId, principal);
    // Keep a pre-goal prompt from starting between the arming CAS snapshot and
    // its durable catalog commit; otherwise that turn could be charged to the goal.
    if (context.goalArming > 0 || context.reviewArming > 0) return { accepted: false, reason: 'busy' };
    const previousTurn = context.liveTurn;
    // Why: ingress can be pending before Engine.submit() exposes its active
    // turn. A second prompt must not replace that turn's output recipient.
    if (previousTurn) {
      if (previousTurn.requestId !== command.request_id) return { accepted: false, reason: 'busy' };
      const repeated = context.ingress.start(command, scopedPrincipal(context, principal));
      return repeated.duplicate ? repeated.result : { accepted: false, reason: 'busy' };
    }
    // An ingress instance forgets its idempotency window on restart, whereas
    // the journal-backed transcript retains submitted request IDs.  A retry
    // must not execute the same prompt again or create two UI rows with one ID.
    requireExternalId(command.request_id, 'request_id');
    if (reservedProjectedMessageId(sessionId, command.request_id)) {
      throw new ContractError('nnd_message_id_reserved', 'NND prompt ID collides with a projected transcript ID');
    }
    if (hasPersistedSubmission(context.engine.transcript, command.request_id)) {
      return { accepted: false, duplicate: true, pending: false };
    }
    // `Engine.submit()` reports a busy turn asynchronously.  A compatibility
    // caller must not receive 204 and confirm its optimistic message when the
    // engine has already rejected that message before the operation settles.
    if (context.engine.active && !context.engine.active.finalized) {
      return { accepted: false, reason: 'busy' };
    }
    const turn = { requestId: command.request_id, activityId: `${sessionId}:turn:${command.request_id}`,
      messageId: `${sessionId}:live:${command.request_id}`, streamedChars: 0, previewLimited: false,
      opened: false, turnId: null, outcome: null, activeTools: new NndActiveTools() };
    context.liveTurn = turn;
    let started;
    try { started = context.ingress.start(command, scopedPrincipal(context, principal)); }
    catch (error) { context.liveTurn = previousTurn; throw error; }
    if (started.duplicate) { context.liveTurn = previousTurn; return started.result; }
    // Why: callers receive the acknowledgement promptly; the engine remains
    // the single owner of turn completion and transcript publication.
    this.#publish(context, 'session.status', { sessionID: sessionId, status: { type: 'busy' } });
    this.#activity(context, `${sessionId}:start:${command.request_id}`, 'turn', 'started', 'Turn started', command.request_id);
    this.#publish(context, 'session.updated', { sessionID: sessionId, info: describe(context) }, true);
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
      if (observeNndQuestion(context, record, (type, properties) => this.#publish(context, type, properties))) return;
      if (record.turn_id) {
        if (turn.turnId && turn.turnId !== record.turn_id) return;
        turn.turnId ??= record.turn_id;
      }
      const observation = nndContextObservation(record);
      const toolsChanged = turn.activeTools.observe(record); const phaseChanged = observeNndSessionState(context, record, turn.activeTools.projection());
      if (toolsChanged && !phaseChanged) context.updatedAt = nextUpdatedAt(context);
      if (toolsChanged || phaseChanged) this.#publish(context, 'session.updated', { sessionID: sessionId, info: describe(context) }, true);
      const phaseActivity = observeNndPhaseActivity(turn, record, sessionId, turn.requestId); if (phaseActivity) this.#publish(context, 'nnd.activity', phaseActivity);
      if (observation) {
        context.contextUsage = observation;
        this.#publish(context, 'session.updated', { sessionID: sessionId, info: describe(context) }, true);
      } else if (record.type === 'stream_delta' && typeof record.text === 'string' && record.text.length > 0) {
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
          this.#activity(context, `${sessionId}:${status === 'started' ? 'ts' : 'tool'}:${toolId}`,
            'tool', status, `${record.tool}: ${record.status}`, undefined,
            { ...record, turnRequestID: turn.requestId });
        }
      } else if (record.type === 'turn_result') {
        turn.outcome = record.outcome;
        context.goalLastTurnRecord = record;
        recordNndGoalTurn(context, record);
      }
    } catch { /* Display output is observational, never a reason to fail an engine turn. */ }
  }
  async resolveChildSession(sessionId, principal) {
    requirePrincipal(principal);
    return this.childSessions.resolve(sessionId, principal);
  }
  list(principal, options = {}) {
    return listNndSessions(this.#contexts, this.childSessions, principal, options);
  }

  async withWorkspaceRevocation(root, action) {
    return this.#workspaceRevocations.with(root, [...this.#contexts.values(), ...this.#quarantined], this.#creating.size, action);
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
    return nndSessionStatuses(this.#contexts, this.childSessions, principal);
  }
  pendingRequests(principal) { requirePrincipal(principal); return ownedPendingRequests(this.#contexts, this.childSessions, principal, samePrincipal); }
  questions(principal) { return listNndQuestions(this.#contexts, principal); }
  settleQuestion(token, principal, body, action) { return settleNndQuestion(this.#contexts, token, principal, body, action); }
  messages(sessionId, principal, { all = false } = {}) {
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
      .slice(all ? 0 : -200)
      .map(({ item, index }) => messageProjection(context, item, index));
  }
  activity(sessionId, principal) {
    requireExternalId(sessionId, 'session_id'); requirePrincipal(principal);
    if (this.#contexts.has(sessionId)) return [...this.#owned(sessionId, principal).activity];
    if (!this.childSessions.get?.(sessionId, principal)) {
      throw new ContractError('nnd_session_unavailable', 'NND session context is unavailable');
    }
    return [...(this.#childActivity.get(sessionId) ?? [])];
  }
  async activityHistoryPage(sessionId, principal, options = {}) {
    const context = this.#owned(sessionId, principal);
    return readActivityPageWithBoundary(this.catalogPath, context, options, () => this.#owned(sessionId, principal), this.eventBus);
  }
  async activityTombstonesPage(principal, options = {}) { return this.tombstones.page(principal, this.#contexts, options); }
  async close(sessionId, principal) {
    const context = this.#owned(sessionId, principal, true);
    if (this.#deleting.has(sessionId)) throw new ContractError('nnd_session_unavailable', 'NND session deletion is already pending');
    context.closing = true; this.#deleting.add(sessionId);
    try {
      let tombstone;
      try { tombstone = await this.tombstones.prepare(context, this.#contexts); }
      catch (error) { context.closing = false; throw error; } // No engine or catalog mutation began.
      // Security: closing a parent revokes its child steering grants before shutdown can fail.
      this.childSessions.unregisterParent?.(sessionId);
      await this.childSnapshotStore.drain();
      await context.engine.shutdown({ version: '1.0', type: 'shutdown', request_id: newId('nnd_close') });
      await this.#commitCatalogChange((contexts) => contexts.delete(sessionId), () => this.#contexts.delete(sessionId));
      await this.tombstones.committed(context, tombstone);
      await this.childSnapshotStore.completeParentClose(context);
      await drainActivityWrites(context);
      await removeActivity(this.catalogPath, sessionId).catch((error) => reportActivityFailure(context, error));
      this.#publish(context, 'session.deleted', { sessionID: sessionId }, true);
      return { closed: true };
    } finally { this.#deleting.delete(sessionId); }
  }
  async shutdown() {
    const contexts = [...this.#contexts.values()];
    const settled = await Promise.allSettled(contexts.map((context) => context.engine.shutdown({
      version: '1.0', type: 'shutdown', request_id: newId('nnd_shutdown'),
    })));
    await Promise.all(contexts.map((context) => drainActivityWrites(context)));
    await this.childSnapshotStore.drain();
    await this.catalogWrites.catch(() => undefined);
    const failed = settled.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
  async #commitCatalogChange(change, commit) {
    if (!this.catalogPath) { change(new Map(this.#contexts)); commit(); return; }
    this.catalogWrites = enqueueNndCatalogChange(this.catalogWrites, this.#contexts, change, commit,
      this.catalogPath, this.persistCatalog, CATALOG_LIMIT_BYTES, this.#quarantined);
    await this.catalogWrites;
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
    this.#activity(context, turn.activityId, 'turn', result.status, result.summary, turn.requestId);
    if (context.liveTurn === turn) {
      context.liveTurn = null;
      context.turnState = 'idle';
      context.updatedAt = nextUpdatedAt(context);
      this.#publish(context, 'session.status', { sessionID: context.sessionId, status: { type: 'idle' } });
      this.#publish(context, 'session.idle', { sessionID: context.sessionId });
    }
    this.#publish(context, 'session.updated', { sessionID: context.sessionId, info: describe(context) }, true);
    if (context.contextUsage) void this.#commitCatalogChange(() => {}, () => {}).catch(() => {
      if (!context.closing) this.#activity(context, `${context.sessionId}:context-save:${turn.requestId}`,
        'notice', 'failed', 'Context estimate could not be saved');
    });
  }
  #activity(context, id, kind, status, summary, evidenceMessageID, toolEvidence) {
    this.#publish(context, 'nnd.activity', { id, sessionID: context.sessionId, kind, status, summary, time: Date.now(),
      ...(evidenceMessageID ? { evidenceMessageID } : {}), ...(toolEvidence ? { toolEvidence } : {}) });
  }
  #observeChildEvent(type, child, payload) {
    const parent = this.#contexts.get(child.parentID);
    if (!parent || (type === 'registered' ? !this.childSessions.belongsToParent(child.id, parent)
      : !this.#childActivity.has(child.id))) return;
    try {
      observeChildLifecycle({ type, child, payload, streams: this.#childStreams, activity: this.#childActivity,
        publish: (eventType, properties, mirror) => publishNndChildEvent(this.eventBus, this.#childActivity,
          parent, child, eventType, properties, mirror),
        messages: () => this.messages(child.id, { subjectId: parent.subjectId, workspaceIds: [...parent.workspaceIds] }) });
      const activity = parentChildActivity(type, child, parent.sessionId, payload, parent.liveTurn?.requestId); if (activity) this.#publish(parent, 'nnd.activity', activity);
    } finally { this.childSnapshotStore.observe(type, child, parent, this.childSessions, this.#childActivity.get(child.id) ?? []); }
  }
  #publish(context, type, properties, mirror = false) {
    if (type === 'nnd.activity') {
      if (properties?.sessionID !== context.sessionId) return;
      const record = appendActivity(context.activity, properties);
      if (!record) return;
      properties = record;
      if (this.catalogPath) { context.activityRevision += 1; scheduleActivityWrite(context, this.catalogPath, this.persistActivity); }
    }
    // Why: a broken display subscriber cannot turn governed work into a false failure.
    try {
      publishNndProjection(this.eventBus, { directory: directoryFor(context), project: context.workspaceIds.values().next().value,
        subjectId: context.subjectId, workspaceIds: [...context.workspaceIds], sessionID: context.sessionId, type, properties, mirror });
    } catch (error) {
      try { context.engine.telemetry?.record('nnd.event_delivery', 'failed', {
        event_type: type, code: error?.code ?? 'event_delivery_failed',
      }); } catch { /* Observational diagnostics cannot replace the engine outcome. */ }
    }
  }
}
