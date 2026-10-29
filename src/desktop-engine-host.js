// SPDX-License-Identifier: Apache-2.0
import { ContractError, newId, requireExternalId } from './ids.js';
import { CanonicalIngress } from './ingress.js';
import { DesktopSessionRegistry } from './desktop-session-registry.js';
import { DesktopAttachmentUploads } from './desktop-attachment-uploads.js';
import { activityStatus, observeChildLifecycle, publishDesktopChildEvent } from './desktop-child-stream.js';
import { hasPersistedSubmission, reservedProjectedMessageId } from './desktop-transcript-identity.js';
import { desktopMessages } from './desktop-message-list.js';
import { desktopContextObservation } from './desktop-context-observation.js';
import { observeDesktopSessionState } from './desktop-turn-state.js';
import { DesktopActiveTools } from './desktop-active-tools.js';
import { desktopCompactionActivity, observeDesktopPhaseActivity } from './desktop-phase-activity.js';
import { publishDesktopTurnCompletion, reportDesktopCompletionFailure } from './desktop-turn-completion.js';
import { parentChildActivity } from './desktop-parent-child-activity.js';
import { describe, nextUpdatedAt, sessionIdOrder, titleOf, directoryOf, directoryFor } from './desktop-session-description.js';
import { createWireEventBus } from './opencode/wire-events.js';
import { readFile, stat } from 'node:fs/promises';
import { persistAtomicJson } from './persistence/atomic-json.js';
import { appendActivity, drainActivityWrites, loadActivity, removeActivity, reportActivityFailure, scheduleActivityWrite } from './desktop-activity-snapshot.js';
import { readActivityPageWithBoundary } from './desktop-activity-boundary.js';
import { DesktopActivityTombstones } from './desktop-activity-tombstones.js';
import { enqueueDesktopCatalogChange } from './desktop-catalog-transaction.js';
import { loadChildSnapshots, DesktopChildSnapshotStore } from './desktop-child-snapshot.js';
import { validatedDesktopGoal, commitDesktopGoal } from './desktop-goal.js';
import { desktopGoalContextEvidence, recordDesktopGoalTurn } from './desktop-goal-evidence.js';
import { runDesktopGoalAudit } from './desktop-goal-audit.js';
import { runDesktopWalkthrough } from './desktop-walkthrough.js';
import { runDesktopAssist } from './desktop-assist.js';
import { runDesktopSessionFork } from './desktop-session-fork.js';
import { runDesktopSessionRevert, runDesktopSessionUnrevert } from './desktop-session-revert.js';
import { DesktopHostLifecycle, shutdownDesktopContext, shutdownDesktopHost } from './desktop-host-lifecycle.js';
import { runDesktopNotification } from './desktop-notification.js';
import { publishDesktopProjection } from './desktop-projection.js';
import { reviewModeSnapshot, commitReviewMode } from './desktop-review-mode.js';
import { ownedPendingRequests } from './desktop-pending-requests.js';
import { listDesktopQuestions, settleDesktopQuestion, observeDesktopQuestion } from './desktop-questions.js';
import { replayConversation, requirePrincipal, samePrincipal, scopedPrincipal, tombstoneCatalogContexts, validCatalogRecord, restoreDesktopContexts, shutdownAfterFailedCreate } from './desktop-session-helpers.js';
import { partitionDesktopCatalog } from './desktop-catalog-admission.js';
import { resolveContextBinding, initializeBoundEngine, assertLiveDesktopWorkspaceBinding } from './desktop-workspace-binding.js';
import { DesktopWorkspaceRevocationGuard } from './desktop-workspace-revocation-guard.js';
import { listDesktopSessions, desktopSessionStatuses } from './desktop-session-list.js';
const CATALOG_LIMIT_BYTES = 1_048_576, LIVE_PREVIEW_LIMIT_CHARS = 262_144;
/** Owns desktop-created engine contexts; HTTP routing supplies the authenticated principal. */
export class DesktopEngineHost {
  #contexts = new Map();
  #creating = new Set(); #deleting = new Set();
  #childStreams = new Map(); #childActivity = new Map();
  #quarantined = [];
  #workspaceRevocations = new DesktopWorkspaceRevocationGuard();
  #uploads = new DesktopAttachmentUploads();
  #lifecycle = new DesktopHostLifecycle();
  constructor(options = {}) {
    if (typeof options.createEngine !== 'function') {
      throw new ContractError('desktop_engine_factory_missing', 'desktop engine host requires an engine factory');
    }
    const limit = options.limit ?? 64;
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new ContractError('desktop_context_capacity_invalid', 'desktop engine context capacity must be a positive integer');
    }
    this.createEngine = options.createEngine; this.primaryWorkspaceBinding = options.primaryWorkspaceBinding ?? null;
    this.limit = limit;
    this.eventBus = options.eventBus ?? createWireEventBus();
    this.childSessions = options.childSessions ?? new DesktopSessionRegistry(options.childSessionLimit ?? 256,
    (type, child, payload) => this.#observeChildEvent(type, child, payload));
    this.catalogPath = options.catalogPath ?? null;
    this.tombstones = new DesktopActivityTombstones(this.catalogPath, options.persistTombstones);
    this.persistCatalog = options.persistCatalog ?? persistAtomicJson;
    this.persistActivity = options.persistActivity ?? persistAtomicJson;
    this.childSnapshotStore = new DesktopChildSnapshotStore(this.catalogPath, options.persistChildSnapshot);
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
      throw new ContractError('desktop_catalog_unavailable', 'desktop session catalog is unavailable', { cause: error });
    }
    let records;
    try { records = JSON.parse(source); } catch { throw new ContractError('desktop_catalog_invalid', 'desktop session catalog is invalid'); }
    if (!Array.isArray(records) || records.length > this.limit) throw new ContractError('desktop_catalog_invalid', 'desktop session catalog is invalid');
    try {
      const { restorable, quarantined } = await partitionDesktopCatalog(records, this.primaryWorkspaceBinding, validCatalogRecord);
      this.#quarantined = quarantined;
      await restoreDesktopContexts(restorable, (sessionId, principal, options) => this.#createContext(sessionId, principal, options, true));
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
  async create(sessionId, principal, options = {}) { this.#lifecycle.assertOpen(); return replayConversation(this.#contexts.get(sessionId), options, () => this.assertWorkspaceBound(sessionId, principal), () => this.#createContext(sessionId, principal, options, false)); }
  #createContext(sessionId, principal, options, restoring) { this.#lifecycle.assertOpen(); return this.#lifecycle.track(this.#createContextWork(sessionId, principal, options, restoring)); }
  async #createContextWork(sessionId, principal, options, restoring) {
    requireExternalId(sessionId, 'session_id');
    requirePrincipal(principal);
    if (this.#contexts.has(sessionId) || this.#quarantined.some((record) => record.sessionId === sessionId)
      || this.#creating.has(sessionId) || this.#deleting.has(sessionId)) {
      throw new ContractError('desktop_session_exists', 'desktop session context already exists');
    }
    if (this.#contexts.size + this.#quarantined.length + this.#creating.size >= this.limit) {
      throw new ContractError('desktop_context_capacity', 'desktop engine context capacity is full');
    }
    this.#creating.add(sessionId);
    let engine;
    try {
      if (!restoring) await removeActivity(this.catalogPath, sessionId); // Remove a crash-left prior incarnation.
      const binding = await resolveContextBinding(this.primaryWorkspaceBinding, principal, options, restoring);
      if (!restoring) await this.tombstones.beforeCreate(sessionId, principal, tombstoneCatalogContexts(this.#contexts, this.#quarantined),
        Boolean(options.creationFingerprint), binding ? { subjectId: principal.subjectId, workspaceIds: [binding.id] } : null);
      if (this.#workspaceRevocations.has(binding)) {
        throw new ContractError('desktop_workspace_in_use', 'Workspace admission is being revoked.');
      }
      engine = await this.createEngine({ ...options, sessionId, desktopSessionRegistry: this.childSessions,
        workspaceBinding: binding, workspaceBindingResolver: this.primaryWorkspaceBinding,
        attachmentUploadRead: (uploadId, mimeType) => this.#uploads.resolve(sessionId, uploadId, mimeType), output: (record) => this.observeOutput(sessionId, record) });
      if (!engine || typeof engine.initialize !== 'function') { throw new ContractError('desktop_engine_invalid', 'desktop engine factory returned an invalid engine'); }
      await initializeBoundEngine(engine, this.primaryWorkspaceBinding, binding, principal, options, restoring);
      if (restoring || options.reviewMode !== undefined) engine.reviewPosture = options.reviewMode === 'unattended' ? 'unattended' : 'auto-review';
      const createdAt = restoring ? options.createdAt : Date.now();
      const activity = restoring ? await loadActivity(this.catalogPath, sessionId, createdAt) : [];
      const context = { sessionId, subjectId: principal.subjectId, creationFingerprint: options.creationFingerprint, modelRoute: options.modelRoute,
        workspaceIds: new Set(binding ? [binding.id] : principal.workspaceIds), engine,
        ...(binding ? { workspaceBinding: binding } : {}),
        title: titleOf(options.title), directory: directoryOf(engine.config?.workspaceRoot) || directoryOf(options.directory), createdAt,
        updatedAt: restoring ? options.updatedAt : createdAt, contextUsage: restoring ? options.contextUsage : null,
        goal: restoring && options.goal ? validatedDesktopGoal(options.goal) : null,
        goalRevision: restoring ? options.goalRevision : 0, goalTurnReceipts: [], goalTurnReceiptsTruncated: false,
        archivedAt: restoring ? options.archivedAt : 0, activity, activityRevision: 0, activityWrite: null,
        ingress: new CanonicalIngress(engine, { interactive: options.interactive === true, questions: Boolean(engine.questionBroker) }), closing: false, goalArming: 0, reviewMode: options.reviewMode ?? 'default', reviewRevision: options.reviewRevision ?? 0, reviewArming: 0 };
      if (restoring) this.#contexts.set(sessionId, context);
      else {
        if (this.#workspaceRevocations.has(binding)) {
          throw new ContractError('desktop_workspace_in_use', 'Workspace admission is being revoked.');
        }
        await this.#commitCatalogChange((contexts) => contexts.set(sessionId, context), () => this.#contexts.set(sessionId, context));
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
    if (this.#lifecycle.stopping || context.timelineMutation || context.timelineShutdown) throw new ContractError('desktop_revert_busy', 'desktop session timeline is changing');
    if (context.reviewArming > 0) throw new ContractError('desktop_session_unavailable', 'review mode change is pending');
    return context.ingress.submit(command, scopedPrincipal(context, principal));
  }
  async assertWorkspaceBound(sessionId, principal) {
    const context = this.#owned(sessionId, principal);
    await assertLiveDesktopWorkspaceBinding(context, this.primaryWorkspaceBinding, principal,
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
    return context.ingress.submit({ version: '1.0', type: 'cancel', request_id: newId('desktop_abort') }, scopedPrincipal(context, principal));
  }
  async rename(sessionId, principal, value) {
    const context = this.#owned(sessionId, principal);
    if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new ContractError('session_name_invalid', 'desktop session title must be bounded printable text');
    }
    const title = value.trim();
    let updatedAt;
    await this.#commitCatalogChange(
      (contexts) => {
        if (context.closing || contexts.get(sessionId) !== context) {
          throw new ContractError('desktop_session_unavailable', 'desktop session context is unavailable');
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
      throw new ContractError('request_invalid', 'desktop archived time must be a nonnegative timestamp');
    }
    let updatedAt;
    await this.#commitCatalogChange(
      (contexts) => {
        if (context.closing || contexts.get(sessionId) !== context) {
          throw new ContractError('desktop_session_unavailable', 'desktop session context is unavailable');
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
  auditGoal(sessionId, principal, body) { return runDesktopGoalAudit(this.#owned(sessionId, principal), body); }
  generateWalkthrough(sessionId, principal, body) { return runDesktopWalkthrough(this.#owned(sessionId, principal), body); }
  generateAssist(sessionId, principal, body) { return runDesktopAssist(this.#owned(sessionId, principal), body); }
  async fork(sessionId, principal, body) {
    this.#lifecycle.assertOpen('desktop_fork_busy', 'desktop session host is shutting down');
    return runDesktopSessionFork(this.#owned(sessionId, principal), { createContext: (childId, options) => this.#createContext(childId, principal, options, false),
      get: (childId) => this.get(childId, principal) }, body);
  }
  generateNotification(sessionId, principal, body) { return runDesktopNotification(this.#owned(sessionId, principal), body); }
  revert(sessionId, principal, body) { return runDesktopSessionRevert(this.#owned(sessionId, principal), body); } unrevert(sessionId, principal) { return runDesktopSessionUnrevert(this.#owned(sessionId, principal)); }
  goalEvidence(sessionId, principal) { return desktopGoalContextEvidence(this.#owned(sessionId, principal)); }
  async setGoal(sessionId, principal, value, expectedId, expectedRevision) {
    const goal = validatedDesktopGoal(value);
    return this.#writeGoal(sessionId, principal, goal, expectedId, expectedRevision);
  }
  async clearGoal(sessionId, principal, expectedId, expectedRevision) {
    return this.#writeGoal(sessionId, principal, null, expectedId, expectedRevision);
  }
  async #writeGoal(sessionId, principal, goal, expectedId, expectedRevision) {
    const context = this.#owned(sessionId, principal);
    return commitDesktopGoal(context, sessionId, goal, expectedId, expectedRevision,
      (change, commit) => this.#commitCatalogChange(change, commit), (...args) => this.#publish(...args));
  }
  submitAsync(sessionId, command, principal) {
    const context = this.#owned(sessionId, principal);
    // Keep a pre-goal prompt from starting between the arming CAS snapshot and
    // its durable catalog commit; otherwise that turn could be charged to the goal.
    if (this.#lifecycle.stopping || context.goalArming > 0 || context.reviewArming > 0 || context.timelineMutation || context.timelineShutdown) return { accepted: false, reason: 'busy' };
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
      throw new ContractError('desktop_message_id_reserved', 'desktop prompt ID collides with a projected transcript ID');
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
      opened: false, turnId: null, outcome: null, activeTools: new DesktopActiveTools() };
    context.liveTurn = turn; let started;
    try { started = context.ingress.start(command, scopedPrincipal(context, principal)); }
    catch (error) { context.liveTurn = previousTurn; throw error; }
    if (started.duplicate) { context.liveTurn = previousTurn; return started.result; }
    void started.operation.then(
      (result) => this.#publishCompletion(context, turn, result?.accepted === false),
      () => this.#publishCompletion(context, turn, true),
    ).catch((error) => reportDesktopCompletionFailure(context, error, 'completion_settlement'));
    // Why: the engine has already accepted work; display preparation cannot turn its
    // acknowledgement into a false rejection or remove the completion observer.
    try {
      this.#uploads.markUsed(sessionId, command.request_id, command.attachments);
      this.#publish(context, 'session.status', { sessionID: sessionId, status: { type: 'busy' } });
      this.#activity(context, `${sessionId}:start:${command.request_id}`, 'turn', 'started', 'Turn started', command.request_id);
      this.#publish(context, 'session.updated', { sessionID: sessionId, info: describe(context) }, true);
    } catch (error) { reportDesktopCompletionFailure(context, error, 'start_projection'); }
    return { accepted: true, request_id: command.request_id };
  }
  async uploadAttachment(sessionId, principal, input) {
    const context = this.#owned(sessionId, principal);
    await this.assertWorkspaceBound(sessionId, principal);
    if (context.engine.config?.attachments?.enabled !== true) {
      throw new ContractError('attachments_disabled', 'Enable native attachments before uploading');
    }
    return this.#uploads.upload(sessionId, context.subjectId, input, context.engine.config.attachments.maxBytes);
  }
  uploadedAttachments(sessionId, principal, requestId, refs) {
    return this.#uploads.assertRefs(sessionId, this.#owned(sessionId, principal).subjectId, requestId, refs);
  }
  hasPersistedSubmission(sessionId, principal, requestId) { requireExternalId(requestId, 'request_id'); return hasPersistedSubmission(this.#owned(sessionId, principal).engine.transcript, requestId); }
  /** Observational engine-output boundary; a display subscriber cannot fail a governed turn. */
  observeOutput(sessionId, record) {
    try {
      const context = this.#contexts.get(sessionId);
      const turn = context?.liveTurn;
      if (!context || context.closing || !turn || record?.session_id !== sessionId) return;
      if (observeDesktopQuestion(context, record, (type, properties) => this.#publish(context, type, properties))) return;
      if (record.turn_id) {
        if (turn.turnId && turn.turnId !== record.turn_id) return;
        turn.turnId ??= record.turn_id;
      }
      const observation = desktopContextObservation(record);
      const toolsChanged = turn.activeTools.observe(record); const phaseChanged = observeDesktopSessionState(context, record, turn.activeTools.projection());
      if (toolsChanged && !phaseChanged) context.updatedAt = nextUpdatedAt(context);
      if (toolsChanged || phaseChanged) this.#publish(context, 'session.updated', { sessionID: sessionId, info: describe(context) }, true);
      const phaseActivity = observeDesktopPhaseActivity(turn, record, sessionId, turn.requestId); if (phaseActivity) this.#publish(context, 'desktop.activity', phaseActivity);
      if (observation) {
        context.contextUsage = observation;
        this.#publish(context, 'session.updated', { sessionID: sessionId, info: describe(context) }, true);
      } else if (record.type === 'context_compaction_status') { this.#publish(context, 'desktop.activity', desktopCompactionActivity(turn, record, sessionId));
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
        recordDesktopGoalTurn(context, record);
      }
    } catch { /* Display output is observational, never a reason to fail an engine turn. */ }
  }
  async resolveChildSession(sessionId, principal) { requirePrincipal(principal); return this.childSessions.resolve(sessionId, principal); }
  list(principal, options = {}) { return listDesktopSessions(this.#contexts, this.childSessions, principal, options); }
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
    throw new ContractError('desktop_session_unavailable', 'desktop session context is unavailable');
  }
  statuses(principal) {
    return desktopSessionStatuses(this.#contexts, this.childSessions, principal);
  }
  pendingRequests(principal) { requirePrincipal(principal); return ownedPendingRequests(this.#contexts, this.childSessions, principal, samePrincipal); }
  questions(principal) { return listDesktopQuestions(this.#contexts, principal); }
  settleQuestion(token, principal, body, action) { return settleDesktopQuestion(this.#contexts, token, principal, body, action); }
  messages(sessionId, principal, { all = false } = {}) {
    const context = this.#contexts.has(sessionId) ? this.#owned(sessionId, principal) : null;
    return desktopMessages(sessionId, principal, context, this.childSessions, this.#childStreams, all);
  }
  activity(sessionId, principal) {
    requireExternalId(sessionId, 'session_id'); requirePrincipal(principal);
    if (this.#contexts.has(sessionId)) return [...this.#owned(sessionId, principal).activity];
    if (!this.childSessions.get?.(sessionId, principal)) {
      throw new ContractError('desktop_session_unavailable', 'desktop session context is unavailable');
    }
    return [...(this.#childActivity.get(sessionId) ?? [])];
  }
  async activityHistoryPage(sessionId, principal, options = {}) {
    const context = this.#owned(sessionId, principal);
    return readActivityPageWithBoundary(this.catalogPath, context, options, () => this.#owned(sessionId, principal), this.eventBus);
  }
  async activityTombstonesPage(principal, options = {}) { return this.tombstones.page(principal, tombstoneCatalogContexts(this.#contexts, this.#quarantined), options); }
  async close(sessionId, principal) { this.#lifecycle.assertOpen('desktop_revert_busy', 'desktop session host is shutting down'); return this.#lifecycle.track(this.#closeContext(sessionId, principal)); }
  async #closeContext(sessionId, principal) {
    const context = this.#owned(sessionId, principal, true);
    if (context.timelineMutation || context.timelineShutdown) throw new ContractError('desktop_revert_busy', 'desktop session timeline is changing');
    if (this.#deleting.has(sessionId)) throw new ContractError('desktop_session_unavailable', 'desktop session deletion is already pending');
    context.closing = true; this.#deleting.add(sessionId);
    try {
      let tombstone;
      try { tombstone = await this.tombstones.prepare(context, tombstoneCatalogContexts(this.#contexts, this.#quarantined), principal); }
      catch (error) { context.closing = false; throw error; } // No engine or catalog mutation began.
      // Security: closing a parent revokes its child steering grants before shutdown can fail.
      this.childSessions.unregisterParent?.(sessionId);
      await this.childSnapshotStore.drain();
      await shutdownDesktopContext(context, newId('desktop_close'));
      await this.#commitCatalogChange((contexts) => contexts.delete(sessionId), () => this.#contexts.delete(sessionId));
      await this.tombstones.committed(context, tombstone, principal);
      await this.childSnapshotStore.completeParentClose(context);
      this.#uploads.clearSession(sessionId);
      await drainActivityWrites(context);
      await removeActivity(this.catalogPath, sessionId).catch((error) => reportActivityFailure(context, error));
      this.#publish(context, 'session.deleted', { sessionID: sessionId }, true);
      return { closed: true };
    } finally { this.#deleting.delete(sessionId); }
  }
  shutdown() {
    return this.#lifecycle.shutdown(() => shutdownDesktopHost({ lifecycle: this.#lifecycle,
      contexts: () => [...this.#contexts.values()], childSnapshotStore: this.childSnapshotStore,
      catalogWrites: () => this.catalogWrites, uploads: this.#uploads }));
  }
  async #commitCatalogChange(change, commit) {
    if (!this.catalogPath) { change(new Map(this.#contexts)); commit(); return; }
    this.catalogWrites = enqueueDesktopCatalogChange(this.catalogWrites, this.#contexts, change, commit,
      this.catalogPath, this.persistCatalog, CATALOG_LIMIT_BYTES, this.#quarantined);
    await this.catalogWrites;
  }
  #owned(sessionId, principal, allowClosing = false) {
    requireExternalId(sessionId, 'session_id');
    requirePrincipal(principal);
    const context = this.#contexts.get(sessionId);
    if (!context || context.closing && !allowClosing || !samePrincipal(context, principal)) {
      throw new ContractError('desktop_session_unavailable', 'desktop session context is unavailable');
    }
    return context;
  }
  #publishCompletion(context, turn, rejected) {
    try {
      this.#uploads.release(context.sessionId, turn.requestId);
    } catch (error) { reportDesktopCompletionFailure(context, error, 'completion_upload_release'); }
    publishDesktopTurnCompletion(context, turn, rejected, {
      messages: (...args) => this.messages(...args),
      publish: (...args) => this.#publish(context, ...args),
      activity: (...args) => this.#activity(context, ...args),
      commitCatalogChange: () => this.#commitCatalogChange(() => {}, () => {}),
    });
  }
  #activity(context, id, kind, status, summary, evidenceMessageID, toolEvidence, turnOutcome) {
    this.#publish(context, 'desktop.activity', { id, sessionID: context.sessionId, kind, status, summary, time: Date.now(),
      ...(evidenceMessageID ? { evidenceMessageID } : {}), ...(toolEvidence ? { toolEvidence } : {}), ...(turnOutcome ? { turnOutcome } : {}) });
  }
  #observeChildEvent(type, child, payload) {
    const parent = this.#contexts.get(child.parentID);
    if (!parent || (type === 'registered' ? !this.childSessions.belongsToParent(child.id, parent)
      : !this.#childActivity.has(child.id))) return;
    try {
      observeChildLifecycle({ type, child, payload, streams: this.#childStreams, activity: this.#childActivity,
        publish: (eventType, properties, mirror) => publishDesktopChildEvent(this.eventBus, this.#childActivity,
          parent, child, eventType, properties, mirror),
        messages: () => this.messages(child.id, { subjectId: parent.subjectId, workspaceIds: [...parent.workspaceIds] }) });
      const activity = parentChildActivity(type, child, parent.sessionId, payload, parent.liveTurn?.requestId); if (activity) this.#publish(parent, 'desktop.activity', activity);
    } finally { this.childSnapshotStore.observe(type, child, parent, this.childSessions, this.#childActivity.get(child.id) ?? []); }
  }
  #publish(context, type, properties, mirror = false) {
    // Why: a broken display subscriber cannot turn governed work into a false failure.
    try {
      if (type === 'desktop.activity') {
        if (properties?.sessionID !== context.sessionId) return;
        const record = appendActivity(context.activity, properties);
        if (!record) return;
        properties = record;
        if (this.catalogPath) { context.activityRevision += 1; scheduleActivityWrite(context, this.catalogPath, this.persistActivity); }
      }
      publishDesktopProjection(this.eventBus, { directory: directoryFor(context), project: context.workspaceIds.values().next().value,
        subjectId: context.subjectId, workspaceIds: [...context.workspaceIds], sessionID: context.sessionId, type, properties, mirror });
    } catch (error) {
      try { context.engine.telemetry?.record('desktop.event_delivery', 'failed', {
        event_type: type, code: error?.code ?? 'event_delivery_failed',
      }); } catch { /* Observational diagnostics cannot replace the engine outcome. */ }
    }
  }
}
