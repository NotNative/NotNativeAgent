// SPDX-License-Identifier: Apache-2.0
import { armMissionDeadline, assertMissionBudget, AuthorityRecord, authorizeAndPersistTurn, missionFailureForError, persistAuthenticatedIntent } from './authority.js';
import { appendRecoveryHint } from './context.js';
import { EventFactory } from './event-factory.js';
import { EventHub, phaseIsCancelable } from './events.js';
import { ContractError, newId } from './ids.js';
import {
  acceptedRecord, assistantMessage, classifyCompletion, failure,
  normalizeFailure, terminalRecord, userMessage,
} from './engine-records.js';
import { admissionFromRetry, createActiveTurn } from './engine-active.js';
import { LifecycleRegistry, StateAuthority } from './lifecycle.js';
import { HealthInspector } from './health.js';
import { recoveryExhaustionDetail, recoveryExhaustionText, recoveryHint } from './recovery.js';
import { JournalStore } from './store.js';
import { SessionLock } from './session-lock.js';
import { restoreSessionRecords } from './session-history.js';
import { toolContinuationHint, toolProgressEvidence } from './tool-loop.js';
import { installEngineComponents } from './engine-components.js';
import { applyPendingConfiguration, updateEngineConfiguration } from './runtime-config.js';
import { userDataPaths } from './product.js';
import { dispatchTurnPreHook, hookPayload } from './engine-hooks.js';
import { boundedShutdown, performEngineShutdown } from './shutdown-boundary.js';
import { executionContext, providerRequest, resetStep, toolContext } from './engine-runtime-helpers.js';
import { clearEngineConversation, compactEngineConversation, handoffEngineConversation } from './engine-context-controls.js';
import { FinalizationFaults } from './finalization-faults.js';
import { evaluateCompletion, partialOutputProgress } from './completion-supervisor.js';
import { recoverProviderContextLimit } from './engine-provider-recovery.js';
import { settleEngineAttempt, settleEngineChildren, settleEngineStep } from './engine-lifecycle-settlement.js';
import { acceptEngineText, emitEngineStatus } from './engine-output.js';
import { assertTurnActive } from './turn-cancellation.js';
import { createForensicTelemetry } from './forensic-telemetry.js';
import { prepareEngineContext } from './engine-context-preparation.js';
import { initializeEngine } from './engine-initialize.js';
import { persistEngineRecord } from './engine-persistence.js';
import { runEngineSubagent, subagentParallelLimit } from './subagent-runtime.js';
export class SessionEngine {
  state = new StateAuthority();
  lifecycles = new LifecycleRegistry();
  authority = new AuthorityRecord();
  transcript = [];
  steering = [];
  recoveryNotices = []; active = null;
  constructor(options) {
    this.config = options.config;
    this.reviewPosture = options.reviewPosture ?? 'auto-review';
    this.runtimeId = options.runtimeId ?? newId('runtime');
    this.sessionId = options.sessionId ?? newId('session');
    this.dataPaths = options.dataPaths ?? userDataPaths();
    this.subagentDepth = options.subagentDepth ?? 0;
    this.subagentOptions = {
      providerFactory: options.providerFactory, semanticReviewer: options.semanticReviewer,
      memoryAdapter: options.memoryAdapter, mcpTransportFactory: options.mcpTransportFactory,
      hookRoot: options.hookRoot, hookRoots: options.hookRoots, skillRoots: options.skillRoots,
      webSearchConfigPath: options.webSearchConfigPath, webSearchClient: options.webSearchClient,
      webFetchConfigPath: options.webFetchConfigPath, lspConfigPath: options.lspConfigPath,
      lspSpawnProcess: options.lspSpawnProcess, attachmentRoot: options.attachmentRoot,
      reviewerRoot: options.reviewerRoot, governanceRoot: options.governanceRoot,
      telemetryRoot: options.telemetryRoot,
    };
    this.telemetry = createForensicTelemetry({
      telemetry: options.telemetry, workspaceRoot: this.config.workspaceRoot,
      runtimeId: this.runtimeId, sessionId: this.sessionId,
      conversationId: options.conversationId ?? this.sessionId,
      root: options.telemetryRoot ?? this.dataPaths.projects,
      dbPath: options.telemetryDbPath, maxAgeMs: options.telemetryMaxAgeMs,
      maxBytes: options.telemetryMaxBytes,
    });
    this.state.setObserver(this.telemetry.stateObserver?.());
    this.lifecycles.setObserver(this.telemetry.lifecycleObserver?.());
    this.events = options.events ?? new EventHub();
    this.events.setObserver?.(this.telemetry.eventObserver());
    this.eventFactory = new EventFactory(this.runtimeId, this.sessionId);
    this.providerFactory = options.providerFactory;
    const storeRoot = options.storeRoot ?? userDataPaths().sessions;
    this.storeRoot = storeRoot;
    this.storeFactory = options.storeFactory ?? ((root, id, storeOptions) => new JournalStore(root, id, storeOptions));
    this.store = this.#createStore(storeRoot);
    this.lock = this.store ? new SessionLock(storeRoot, this.sessionId) : null;
    installEngineComponents(this, options, storeRoot, {
      persist: (type, payload) => this.#persist(type, payload),
      publish: (...args) => this.#publish(...args),
      toolContext: (active) => toolContext(this, active),
      executionContext: (active) => executionContext(this, active),
      acceptText: (text, active) => acceptEngineText(this, text, active),
      settleAttempt: (active, outcome) => settleEngineAttempt(
        this, active, outcome, (...args) => this.#publish(...args),
      ),
      recordRecovery: (action, active) => this.#recordRecovery(action, active),
      scheduler: options.scheduler,
      queueStatus: (active, position) => this.output({
        version: '1.0', type: 'queue_status', session_id: this.sessionId,
        turn_id: active.turnId, position,
      }),
    });
  }
  async initialize(options = {}) {
    return initializeEngine(this, {
      restore: (records, truncated) => this.#restore(records, truncated),
      createSessionRecord: () => this.#createSessionRecord(),
      markInterrupted: (turnId) => this.#markInterrupted(turnId),
    }, options);
  }

  async submit(command, principal) {
    if (this.state.state !== 'idle') return this.#rejectBusy(command);
    const turn = this.lifecycles.start('turn');
    this.active = createActiveTurn(turn.id, command.request_id, this.config.recovery);
    const active = this.active;
    active.enrichment.skills = this.skills.beginTurn();
    let operation;
    try {
      this.state.transition('preparing_turn', { trigger: 'submission_accepted', turnId: turn.id });
      active.prompt = command.content;
      await persistAuthenticatedIntent(this.authority, command.content, principal, (intent) => this.#persist('authority_intent', intent));
      active.authority = this.authority.snapshot(this.config);
      active.authority = await authorizeAndPersistTurn(this.authority, this.config, (record) => this.#persist('mission_turn_authorized', record));
      armMissionDeadline(active);
      await this.#persist('message', userMessage(turn.id, command.content));
      await this.#persist('turn_accepted', { turnId: turn.id, requestId: command.request_id });
      await this.output(acceptedRecord(command.request_id, this, turn.id));
      await emitEngineStatus(this, 'preparing', active);
      operation = this.#runTurn(command.content, command.attachments ?? [], command.retry_attachment_id ?? null);
    } catch (error) {
      operation = this.#finalize('failed', '', normalizeFailure(missionFailureForError(active, error), false, this.active?.turnId));
    }
    operation.then(active.resolveCompletion, active.resolveCompletion);
    return operation;
  }

  retryAttachment(command, principal) {
    return this.submit({ ...command, retry_attachment_id: command.attachment_id }, principal);
  }

  async removeAttachment(command) {
    if (this.state.state !== 'idle') throw new ContractError('attachment_busy', 'attachment cannot be removed during an active turn');
    const removed = await this.attachments.remove(command.attachment_id);
    await this.output({
      version: '1.0', type: 'accepted', request_id: command.request_id,
      command_type: 'attachment_remove', accepted: removed, attachment_id: command.attachment_id,
    });
    return { accepted: removed };
  }

  async cancel(command) {
    if (!this.active) return { accepted: true, already_terminal: true };
    this.active.cancelled = true;
    this.active.controller.abort();
    if (!['cancelling', 'finalizing_turn', 'idle'].includes(this.state.state)) {
      this.state.transition('cancelling', { trigger: 'cancel_command', turnId: this.active.turnId });
    }
    await emitEngineStatus(this, 'cancelling', this.active);
    return { accepted: true, turn_id: this.active.turnId, request_id: command.request_id };
  }

  decidePermission(command, principal) {
    if (!this.permissionBroker) throw new ContractError('interactive_decision_forbidden', 'interactive permission is unavailable');
    return this.permissionBroker.decide(command, principal);
  }

  async updateConfiguration(command, principal) {
    return updateEngineConfiguration(this, command, principal);
  }

  async steer(command, principal) {
    if (!this.active || this.active.finalized) return { accepted: false, reason: 'no_active_turn' };
    if (this.steering.length >= this.config.limits.maxSteering) {
      throw new ContractError('steering_capacity', 'steering queue is full');
    }
    const record = Object.freeze({
      id: newId('steering'), requestId: command.request_id,
      content: command.content, principal, turnId: this.active.turnId,
      acceptedAt: new Date().toISOString(), consumed: false,
    });
    if (this.store) await this.store.append('steering_accepted', record);
    this.steering.push(record);
    await this.output({
      version: '1.0', type: 'accepted', request_id: command.request_id,
      accepted: true, command_type: 'steer', steering_id: record.id,
      turn_id: this.active.turnId, session_id: this.sessionId,
    });
    return { accepted: true, steering_id: record.id };
  }
  async shutdown(command) {
    return boundedShutdown(this, () => performEngineShutdown(this, command));
  }
  reviewerAudit(limit = 100) { return this.ledger.audit(limit); }
  governanceAudit(limit = 100) { return this.governance.audit(limit); }
  health() {
    return new HealthInspector(this).inspect();
  }
  saveMemory(content, options) {
    return this.memory.saveExplicit(content, this.config.workspaceRoot, options);
  }
  inspectMemory() {
    return this.memory.inspect(this.config.workspaceRoot);
  }
  workStatus() { return this.work.snapshot(); }
  setGoal(objective) { return this.work.setGoal(objective); }
  completeGoal(evidence) { return this.work.completeGoal(evidence); }
  reopenGoal() { return this.work.reopenGoal(); }
  addTask(title) { return this.work.addTask(title); }
  updateTask(id, status, detail) { return this.work.updateTask(id, status, detail); }

  deleteMemory(id, expectedVersion) {
    return this.memory.delete(id, this.config.workspaceRoot, expectedVersion);
  }

  async compactConversation() {
    return compactEngineConversation(this);
  }
  async handoffConversation() {
    return handoffEngineConversation(this);
  }
  async clearConversation() {
    return clearEngineConversation(this);
  }
  async runSubagent(input, signal) {
    return runEngineSubagent(this, input, signal, (options) => new SessionEngine(options));
  }
  parallelToolLimit(group, signal) { return subagentParallelLimit(this, group, signal); }
  async #runTurn(content, attachmentInputs, retryAttachmentId) {
    const active = this.active;
    try {
      assertTurnActive(active);
      const allowed = await dispatchTurnPreHook(this, active, content);
      assertTurnActive(active);
      if (!allowed) return this.#finalize('denied', '', failure('pre_turn_denied', false));
      if (attachmentInputs.length > 0 || retryAttachmentId) {
        active.admission = retryAttachmentId
          ? admissionFromRetry(await this.attachments.retry(retryAttachmentId, content, active.controller.signal))
          : await this.attachments.prepare(attachmentInputs, content, active.controller.signal);
        assertTurnActive(active);
        if (active.admission.failures.length > 0) {
          return this.#finalize('needs_input', '', {
            code: 'attachment_partial_admission', retryable: active.admission.failures.some((item) => item.state === 'pending_failed'),
            partial: false, side_effect_certainty: 'none', pending_text: content,
          });
        }
      }
      const recall = await this.memory.recall(content, this.config.workspaceRoot, active.controller.signal);
      assertTurnActive(active);
      active.enrichment.memory = recall.items;
      if (!['disabled', 'ready'].includes(recall.status)) {
        await this.output({ type: 'memory_status', status: recall.status, reason: recall.reason ?? null, turn_id: active.turnId });
      }
      const prior = this.transcript.filter((item) => !(item.type === 'message'
        && item.role === 'user' && item.turnId === active.turnId));
      applyPendingConfiguration(this, active);
      let context = await this.#prepareContext(prior, content, active);
      while (true) {
        const result = await this.#runModelStep(context, active);
        if (result.exhausted) {
          const detail = recoveryExhaustionDetail(active.recovery, this.transcript, active.unresolvedToolFailures, result);
          return this.#finalize('incomplete', recoveryExhaustionText(detail, {
            transcript: this.transcript, turnId: active.turnId,
          }), detail);
        }
        if (!result.continue) return this.#completeFromStep(result, active);
        applyPendingConfiguration(this, active);
        context = await this.#prepareContext(this.transcript, '', active, result.forceCompact);
        context = appendRecoveryHint(context, result.hint);
      }
    } catch (error) {
      error = missionFailureForError(active, error);
      const outcome = active.cancelled ? 'cancelled' : 'failed';
      return this.#finalize(outcome, active.stepText, normalizeFailure(error, active.stepText.length > 0, active.turnId));
    }
  }

  async #runModelStep(context, active) {
    assertTurnActive(active);
    assertMissionBudget(active);
    resetStep(active);
    const step = this.lifecycles.start('model_step', active.turnId);
    active.stepId = step.id;
    await this.#publish('model_step.started', 'model_step', 'active', active);
    const routes = this.router.candidates('primary', { requiredCapabilities: ['tools'] });
    if (routes.length === 0) this.router.resolve('primary', { requiredCapabilities: ['tools'] });
    active.sessionId = this.sessionId;
    await emitEngineStatus(this, 'waiting_provider', active);
    try {
      await this.providerRunner.runRoutes(this.router, routes, (route) => providerRequest(this, route, context), {
        firstTokenMs: this.config.limits.firstTokenMs,
        idleMs: this.config.limits.idleMs,
      }, active);
    } catch (error) {
      if (error.code !== 'provider_context_limit') throw error;
      return recoverProviderContextLimit(this, error, active, {
        settleAttempt: (outcome) => this.#settleAttempt(active, outcome), settleStep: (outcome) => this.#settleStep(active, outcome),
        recordRecovery: (action) => this.#recordRecovery(action, active), hint: recoveryHint,
      });
    }
    assertTurnActive(active);
    const calls = active.toolAssembler.complete();
    if (calls.length === 0) return this.#afterTextStep(active);
    await this.#settleAttempt(active, 'completed');
    if (active.stepText.length > 0) await this.#persist('message', assistantMessage(
      active.turnId, active.stepText, { stepId: active.stepId },
    ));
    const items = await this.toolLoop.process(calls, active);
    active.unresolvedToolFailures = items.filter((item) => item.result.status !== 'succeeded')
      .map((item) => item.result.reason_code ?? item.result.status).slice(0, 64);
    const steeringApplied = await this.#consumeSteering(active);
    const evidence = toolProgressEvidence(items, steeringApplied);
    const progress = active.recovery.noProgress(
      'tool_no_progress', evidence, {}, { allowCompaction: active.contextPressureTier === 'compact' },
    );
    if (progress.action) await this.#recordRecovery(progress.action, active);
    await this.#settleStep(active, 'continued');
    if (!progress.continue) return { exhausted: true, category: 'tool_no_progress', count: progress.count };
    this.state.transition('preparing_continuation', { trigger: 'tool_results_committed', turnId: active.turnId });
    return {
      continue: true, hint: toolContinuationHint(items, recoveryHint(progress.action)),
      forceCompact: progress.action?.action === 'compact',
    };
  }
  async #afterTextStep(active) {
    if (active.stepText.length === 0) {
      await this.#settleAttempt(active, 'empty');
      this.state.transition('recovering', { trigger: 'empty_output', turnId: active.turnId });
      const plan = active.recovery.noProgress(
        'empty_output', null, {}, { allowCompaction: active.contextPressureTier === 'compact' },
      );
      if (plan.action) await this.#recordRecovery(plan.action, active);
      await this.#settleStep(active, plan.continue ? 'recovering' : 'incomplete');
      if (!plan.continue) return { exhausted: true, category: 'empty_output', count: plan.count };
      this.state.transition('preparing_continuation', { trigger: 'empty_output_recovery', turnId: active.turnId });
      return {
        continue: true, hint: recoveryHint(plan.action),
        forceCompact: plan.action?.action === 'compact',
      };
    }
    if (this.steering.length > 0) {
      await this.#settleAttempt(active, 'completed');
      this.state.transition('evaluating_completion', { trigger: 'queued_steering', turnId: active.turnId });
      await this.#consumeSteering(active);
      await this.#settleStep(active, 'continued');
      this.state.transition('preparing_continuation', { trigger: 'steering_applied', turnId: active.turnId });
      return { continue: true };
    }
    const supervised = evaluateCompletion(active, active.stepText);
    if (supervised.disposition !== 'continue') {
      return { continue: false, text: active.stepText, outcome: supervised.disposition };
    }
    await this.#settleAttempt(active, 'completed');
    await this.#persist('message', assistantMessage(active.turnId, active.stepText, {
      partial: true, stepId: active.stepId,
    }));
    this.state.transition('recovering', { trigger: supervised.category, turnId: active.turnId });
    const plan = active.recovery.continuation(
      supervised.category, supervised.progressEvidence, partialOutputProgress(active.stepText),
      { allowCompaction: active.contextPressureTier === 'compact' },
    );
    if (plan.action) await this.#recordRecovery(plan.action, active);
    await this.#settleStep(active, plan.continue ? 'recovering' : 'incomplete');
    if (!plan.continue) return { exhausted: true, category: supervised.category, count: plan.count };
    this.state.transition('preparing_continuation', { trigger: supervised.category, turnId: active.turnId });
    return { continue: true, hint: recoveryHint(plan.action) };
  }

  async #recordRecovery(action, active) {
    await emitEngineStatus(this, 'recovering', active);
    const lifecycle = this.lifecycles.start('recovery', active.stepId ?? active.turnId);
    await this.#publish('recovery.started', 'recovery', 'active', active);
    await this.#persist('recovery_decision', {
      ...action, turnId: active.turnId, stepId: active.stepId, lifecycleId: lifecycle.id,
    });
    this.lifecycles.finish(lifecycle.id, 'applied');
    await this.#publish('recovery.terminal', 'recovery', 'terminal', active, 'applied');
  }

  async #consumeSteering(active) {
    const consumed = [];
    while (this.steering.length > 0) {
      const steering = this.steering.shift();
      const lifecycle = this.lifecycles.start('steering', active.stepId ?? active.turnId);
      await this.#publish('steering.started', 'steering', 'active', active);
      await persistAuthenticatedIntent(this.authority, steering.content, steering.principal, (intent) => this.#persist('authority_intent', intent));
      active.authority = this.authority.snapshot(this.config);
      const message = userMessage(active.turnId, steering.content, { steeringId: steering.id });
      const consumedRecord = { id: steering.id, consumedAt: new Date().toISOString(), message };
      if (this.store) await this.store.append('steering_consumed', consumedRecord);
      this.transcript.push(message);
      active.recovery.externalEvidence(steering.id);
      this.lifecycles.finish(lifecycle.id, 'consumed');
      await this.#publish('steering.terminal', 'steering', 'terminal', active, 'consumed');
      consumed.push(steering.id);
    }
    return Object.freeze(consumed);
  }

  async #prepareContext(records, content, active, force = false) {
    return prepareEngineContext(this, records, content, active, force, {
      persist: (type, payload) => this.#persist(type, payload),
      publish: (...args) => this.#publish(...args),
    });
  }

  async #completeFromStep(result, active) {
    assertMissionBudget(active); this.state.transition('evaluating_completion', { trigger: 'stream_sealed', turnId: active.turnId });
    active.finalText = result.text;
    return this.#finalize(result.outcome ?? classifyCompletion(result.text), result.text, null);
  }

  async #finalize(outcome, text, failureDetail) {
    const active = this.active;
    if (!active || active.finalized) throw new ContractError('duplicate_finalization', 'turn already finalized');
    active.finalized = true; clearTimeout(active.missionTimer);
    const faults = new FinalizationFaults(failureDetail, outcome, active.turnId);
    if (this.state.state !== 'finalizing_turn') {
      await faults.capture('state', () => this.state.transition(
        'finalizing_turn', { trigger: `terminal_${outcome}`, turnId: active.turnId },
      ));
    }
    await faults.capture('lifecycle', () => settleEngineChildren(
      this, active, faults.outcome, (...args) => this.#publish(...args),
    ));
    if (text.length > 0) await faults.capture('persistence', () => this.#persist(
      'message', assistantMessage(active.turnId, text, { ...faults.primary, stepId: active.stepId }),
    ));
    await faults.capture('lifecycle', () => this.lifecycles.finish(active.turnId, faults.outcome));
    await faults.capture('event', () => this.#publish(
      'turn.terminal', 'turn', 'terminal', active, faults.outcome, hookPayload(this, active, {
      model_response: text,
      }),
    ));
    await faults.capture('state', () => this.state.transition(
      'idle', { trigger: 'finalization_committed', turnId: active.turnId },
    ));
    this.active = null;
    const work = this.work?.snapshot();
    if (work && (work.goal || work.tasks.length > 0)) {
      await faults.capture('persistence', () => this.#persist('work_state', work));
    }
    let terminal = terminalRecord(this, active, faults.outcome, text, faults.primary, faults.secondary);
    await faults.capture('persistence', () => this.#persist('turn_outcome', terminal));
    faults.latchCommit();
    terminal = terminalRecord(this, active, faults.outcome, text, faults.primary, faults.secondary);
    await faults.capture('output', () => this.output(terminal));
    return terminalRecord(this, active, faults.outcome, text, faults.primary, faults.secondary);
  }

  #settleAttempt(active, outcome) {
    return settleEngineAttempt(this, active, outcome, (...args) => this.#publish(...args));
  }

  #settleStep(active, outcome) {
    return settleEngineStep(this, active, outcome, (...args) => this.#publish(...args));
  }

  async #publish(name, category, phase, active, outcome = null, payload = {}) {
    const event = this.eventFactory.create(name, category, phase, active, payload, outcome);
    const signal = phaseIsCancelable(category, phase) ? active?.controller?.signal : undefined;
    const dispatch = await this.events.dispatch(event, signal);
    await this.#persist('lifecycle_event', event);
    return dispatch;
  }

  async #persist(type, payload) {
    return persistEngineRecord(this, type, payload);
  }

  #createStore(root) {
    return this.config.persistence === 'ephemeral' ? null
      : this.storeFactory(root ?? userDataPaths().sessions, this.sessionId, { persistenceDeadlineMs: this.config.limits.persistenceFlushMs });
  }
  async #createSessionRecord() {
    await this.store.append('session_created', {
      sessionId: this.sessionId, runtimeId: this.runtimeId,
      configVersion: this.config.version, manifestProvenance: this.config.provenance,
      executionManifest: this.config.executionManifest, mission: this.config.mission,
    });
  }

  async #markInterrupted(turnId) {
    const record = {
      turnId, outcome: 'failed', reason: 'process_interrupted',
      replayed: false, detectedAt: new Date().toISOString(),
    };
    await this.store.append('turn_interrupted', record);
    this.recoveryNotices.push(Object.freeze(record));
  }

  async #rejectBusy(command) {
    await this.output({ type: 'accepted', request_id: command.request_id, accepted: false, reason: 'busy' });
    return { accepted: false, reason: 'busy' };
  }

  #restore(records, truncated = false) {
    const restored = restoreSessionRecords(records);
    this.work.restore(records);
    this.transcript.push(...restored.transcript);
    this.authority.restore(restored.authority, restored.missionTurns, { conversationComplete: !truncated || restored.authorityReset, requireMissionUsage: Boolean(this.config.mission), missionUsageComplete: !truncated || restored.missionTurns.length > 0 });
    this.toolLoop.restore(restored.transcript);
    this.steering.push(...restored.steering);
    return restored.interrupted;
  }
}
