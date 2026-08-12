// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { DreamStore } from './dream-store.js';
import { IdleArbiter } from './idle-arbiter.js';
import { userDataPaths } from './product.js';
import { diagnoseDreamEvidence } from './dream-diagnosis.js';
import { LearningCandidateRegistry } from './learning-candidates.js';
import { governanceFingerprint } from './governance-contracts.js';
import { NnmGovernanceReceipts } from './nnm-governance-receipts.js';
import { NnmHygieneReceipts } from './nnm-hygiene-receipts.js';
import { admitHygieneReceipt, admitNnmReceipt } from './dream-governance-admission.js';
import { observeSkillRequests } from './skill-opportunity.js';
import {
  explicitProjectKnowledge, ProjectMemoryReconciler, projectMemoryCandidate,
} from './project-memory-reconciler.js';

export class DreamCoordinator {
  constructor(options) {
    this.workspace = options.workspace;
    this.config = options.config;
    this.runtimeKey = workspaceKey(this.config.workspaceRoot);
    this.store = options.store ?? new DreamStore({
      path: options.path ?? userDataPaths().dreamState, retentionDays: this.config.dream.retentionDays,
    });
    this.store.setObserver?.((event) => this.#recordStage(event));
    this.state = { state: 'starting', reason: null, lastResult: null };
    this.nnmReceipts = options.nnmReceipts ?? new NnmGovernanceReceipts({ path: options.nnmReceiptPath });
    this.nnmHygieneReceipts = options.nnmHygieneReceipts ?? new NnmHygieneReceipts({ path: options.nnmReceiptPath });
    this.arbiter = new IdleArbiter({
      idleMs: this.config.dream.idleMs, interStageMs: this.config.dream.interStageMs,
      eligible: () => this.#eligible(), runStage: (request) => this.#runNext(request),
      onState: (event) => { this.state = { ...this.state, ...event }; },
    });
  }
  async initialize() {
    await this.store.initialize();
    this.state = { state: this.config.dream.enabled ? 'waiting' : 'disabled', reason: null, lastResult: null };
    if (this.config.dream.enabled) this.arbiter.start();
    return this.status();
  }
  activity(reason) { if (this.config.dream.enabled) this.arbiter.activity(reason); }
  pause() { this.arbiter.pause(); }
  resume() { if (this.config.dream.enabled) this.arbiter.resume(); }
  runNow() { return this.arbiter.runNow(); }
  status() {
    const pending = this.store.pendingPacket(this.runtimeKey);
    return {
      enabled: this.config.dream.enabled, state: this.state.state, reason: this.state.reason,
      workspace: this.config.workspaceRoot, watermark: this.store.watermark(this.runtimeKey),
      pending: pending ? {
        id: pending.id, stage: pending.stage, created_at: pending.created_at,
        updated_at: pending.updated_at, result_code: pending.result_code,
      } : null,
      store: this.store.status(), recent: this.store.recent(10),
    };
  }
  candidates(limit = 50) {
    return this.store.candidates({ limit }).map(candidateSummary);
  }
  candidate(id) {
    const candidate = this.store.candidate(id);
    if (!candidate) throw Object.assign(new Error('learning candidate does not exist'), { code: 'dream_candidate_missing' });
    return candidateSummary(candidate, true);
  }
  async rejectCandidate(id, reason) {
    const registry = new LearningCandidateRegistry({
      store: this.store, governance: this.#engine().governance, runtimeKey: this.runtimeKey,
      scope: { kind: 'workspace', fingerprint: governanceFingerprint(this.config.workspaceRoot) },
      telemetry: this.#engine().telemetry,
    });
    return candidateSummary(await registry.reject(id, reason));
  }
  close() { this.arbiter.close(); this.store.close(); }
  async #eligible() {
    if (!this.config.dream.enabled || this.workspace.sessions.size === 0) return false;
    for (const session of this.workspace.sessions.values()) {
      if (session.engine.state.state !== 'idle') return false;
    }
    return this.store.pendingPacket(this.runtimeKey) !== null || (await this.#newEvidence()).length > 0;
  }
  async #runNext(request) {
    const packet = this.store.pendingPacket(this.runtimeKey);
    if (!packet) return this.#harvest(request);
    if (packet.stage === 1) return this.#diagnose(packet, request);
    if (packet.stage === 2) return this.#projectMemory(packet, request);
    if (packet.stage === 3) return this.#reconcileNnm(packet, request);
    if (packet.stage === 4) return this.#scanNnmHygiene(packet, request);
    throw Object.assign(new Error('unsupported dream packet stage'), { code: 'dream_stage_invalid' });
  }
  async #harvest({ trigger, signal }) {
    const started = performance.now();
    const rows = await this.#newEvidence();
    if (signal.aborted) throw cancelled();
    if (rows.length === 0) return { code: 'no_new_evidence', records: 0 };
    const first = rows[0], last = rows.at(-1);
    const packet = evidencePacket(rows);
    const run = this.store.begin({
      runtimeKey: this.runtimeKey, stage: 0, trigger, evidenceStart: first.id, evidenceEnd: last.id,
      inputFingerprint: fingerprint(packet),
    });
    try {
      if (signal.aborted) throw cancelled();
      const engine = this.#engine();
      const windowFingerprint = fingerprint(packet);
      const evidence = await engine.governance.registerEvidence({
        id: `evidence:dream-window:${this.runtimeKey}:${first.id}-${last.id}`,
        kind: 'dream_evidence_window', origin: 'runtime', trust: 'observed', state: 'active',
        freshness: 'current', conflict: 'none', sourceRef: `telemetry:${first.id}-${last.id}`,
        sourceFingerprint: windowFingerprint, contentFingerprint: windowFingerprint,
        scope: { kind: 'workspace', fingerprint: governanceFingerprint(this.config.workspaceRoot) },
        observedAt: Date.now(), attributes: { records: rows.length, turns: packet.turns },
      });
      const durablePacket = this.store.savePacket({
        runtimeKey: this.runtimeKey, evidenceStart: first.id, evidenceEnd: last.id,
        evidenceId: evidence.id, payload: packet,
      });
      const result = { code: 'harvest_complete', records: rows.length, packet_id: durablePacket.id, packet };
      this.store.finish(run.id, 'completed', {
        resultCode: result.code, durationMs: performance.now() - started,
        outputFingerprint: fingerprint(result),
      });
      this.store.commitWatermark({
        runtimeKey: this.runtimeKey, sessionId: last.session_id,
        turnSequence: last.id, stage: 1, configGeneration: this.config.version,
      });
      this.state.lastResult = result;
      return result;
    } catch (error) {
      this.store.finish(run.id, signal.aborted ? 'cancelled' : 'failed', {
        resultCode: signal.aborted ? 'activity_cancelled' : (error.code ?? 'harvest_failed'),
        durationMs: performance.now() - started,
      });
      throw error;
    }
  }
  async #diagnose(packet, { trigger, signal }) {
    const started = performance.now();
    const run = this.store.begin({
      runtimeKey: this.runtimeKey, stage: 1, trigger,
      evidenceStart: packet.evidence_start, evidenceEnd: packet.evidence_end,
      inputFingerprint: packet.payload_fingerprint,
    });
    try {
      if (signal.aborted) throw cancelled();
      const registry = new LearningCandidateRegistry({
        store: this.store, governance: this.#engine().governance,
        runtimeKey: this.runtimeKey,
        scope: { kind: 'workspace', fingerprint: governanceFingerprint(this.config.workspaceRoot) },
        telemetry: this.#engine().telemetry,
      });
      const candidates = [];
      for (const issue of packet.payload.diagnosis?.issues ?? []) {
        if (signal.aborted) throw cancelled();
        if (issue.code !== 'repeated_reason') continue;
        candidates.push(await registry.observe(reliabilityCandidate(issue, packet.governance_evidence_id)));
      }
      const skillCandidates = await observeSkillRequests({
        records: this.#transcriptRecords(), turnRefs: packet.payload.turn_refs,
        engine: this.#engine(), store: this.store, runtimeKey: this.runtimeKey,
        scope: { kind: 'workspace', fingerprint: governanceFingerprint(this.config.workspaceRoot) }, signal,
      });
      candidates.push(...skillCandidates);
      this.store.advancePacket(packet.id, 2, 'operational_diagnosis_complete');
      this.store.finish(run.id, 'completed', {
        resultCode: 'operational_diagnosis_complete', durationMs: performance.now() - started,
        outputFingerprint: fingerprint(candidates.map((item) => item.id)),
      });
      this.store.commitWatermark({
        runtimeKey: this.runtimeKey, sessionId: null,
        turnSequence: packet.evidence_end, stage: 2, configGeneration: this.config.version,
      });
      const result = {
        code: 'operational_diagnosis_complete', packet_id: packet.id,
        issues: packet.payload.diagnosis?.issues?.length ?? 0, candidates: candidates.length,
      };
      this.state.lastResult = result;
      return result;
    } catch (error) {
      this.store.finish(run.id, signal.aborted ? 'cancelled' : 'failed', {
        resultCode: signal.aborted ? 'activity_cancelled' : (error.code ?? 'diagnosis_failed'),
        durationMs: performance.now() - started,
      });
      throw error;
    }
  }
  async #projectMemory(packet, { trigger, signal }) {
    const started = performance.now();
    const run = this.store.begin({
      runtimeKey: this.runtimeKey, stage: 2, trigger,
      evidenceStart: packet.evidence_start, evidenceEnd: packet.evidence_end,
      inputFingerprint: packet.payload_fingerprint,
    });
    try {
      if (signal.aborted) throw cancelled();
      const decisions = explicitProjectKnowledge(this.#transcriptRecords(), packet.payload.turn_refs);
      if (decisions.length === 0) return this.#finishProjectMemorySkipped(run, packet, started);
      const engine = this.#engine();
      const scope = { kind: 'workspace', fingerprint: governanceFingerprint(this.config.workspaceRoot) };
      const { evidenceRefs, sections } = await registerProjectDecisions(engine, decisions, scope, signal);
      const proposal = await new ProjectMemoryReconciler(this.config.workspaceRoot)
        .proposeAppend({ evidenceRefs, sections });
      if (proposal.expected_hash === proposal.proposed_hash) {
        return this.#finishProjectMemorySkipped(run, packet, started, 'project_memory_already_current');
      }
      const registry = new LearningCandidateRegistry({
        store: this.store, governance: engine.governance, runtimeKey: this.runtimeKey,
        scope, telemetry: engine.telemetry,
      });
      const candidate = await registry.observe({
        ...projectMemoryCandidate(proposal, evidenceRefs),
        id: `candidate-project-memory-${proposal.proposed_hash.slice(0, 24)}`,
      });
      this.store.advancePacket(packet.id, 3, 'project_memory_proposal_created');
      this.store.finish(run.id, 'completed', {
        resultCode: 'project_memory_proposal_created', durationMs: performance.now() - started,
        outputFingerprint: candidate.payload_fingerprint,
      });
      this.store.commitWatermark({
        runtimeKey: this.runtimeKey, sessionId: null, turnSequence: packet.evidence_end,
        stage: 3, configGeneration: this.config.version,
      });
      const result = {
        code: 'project_memory_proposal_created', packet_id: packet.id,
        candidate_id: candidate.id, decisions: decisions.length,
      };
      this.state.lastResult = result;
      return result;
    } catch (error) {
      this.store.finish(run.id, signal.aborted ? 'cancelled' : 'failed', {
        resultCode: signal.aborted ? 'activity_cancelled' : (error.code ?? 'project_memory_failed'),
        durationMs: performance.now() - started,
      });
      throw error;
    }
  }
  #finishProjectMemorySkipped(run, packet, started, code = 'project_memory_no_eligible_evidence') {
    this.store.advancePacket(packet.id, 3, code);
    this.store.finish(run.id, 'skipped', { resultCode: code, durationMs: performance.now() - started });
    this.store.commitWatermark({
      runtimeKey: this.runtimeKey, sessionId: null, turnSequence: packet.evidence_end,
      stage: 3, configGeneration: this.config.version,
    });
    const result = { code, packet_id: packet.id };
    this.state.lastResult = result;
    return result;
  }
  async #reconcileNnm(packet, { trigger, signal }) {
    const started = performance.now();
    const run = this.store.begin({
      runtimeKey: this.runtimeKey, stage: 3, trigger,
      evidenceStart: packet.evidence_start, evidenceEnd: packet.evidence_end,
      inputFingerprint: packet.payload_fingerprint,
    });
    try {
      if (signal.aborted) throw cancelled();
      const hook = nnmHook(this.#engine().hooks?.health?.());
      if (!hook || !supportsReceipts(hook.version)) return this.#finishNnmSkipped(run, packet, started, 'nnm_receipt_contract_unavailable');
      const receipts = await this.nnmReceipts.matching({
        workspaceRoot: this.config.workspaceRoot,
        sessionIds: packet.payload.session_refs ?? [], turnIds: packet.payload.turn_refs ?? [],
      });
      if (signal.aborted) throw cancelled();
      if (receipts.length === 0 && Date.now() - Date.parse(packet.created_at) < 900_000) {
        this.store.finish(run.id, 'skipped', {
          resultCode: 'nnm_receipt_pending', durationMs: performance.now() - started,
        });
        return { code: 'nnm_receipt_pending', packet_id: packet.id };
      }
      const engine = this.#engine();
      for (const receipt of receipts) await admitNnmReceipt(engine, receipt, this.config.workspaceRoot);
      this.store.advancePacket(packet.id, 4, receipts.length > 0 ? 'nnm_reconciled' : 'nnm_receipt_timeout');
      this.store.finish(run.id, receipts.length > 0 ? 'completed' : 'skipped', {
        resultCode: receipts.length > 0 ? 'nnm_reconciled' : 'nnm_receipt_timeout',
        durationMs: performance.now() - started,
        outputFingerprint: fingerprint(receipts.map((item) => item.receipt_id)),
      });
      this.store.commitWatermark({
        runtimeKey: this.runtimeKey, sessionId: null, turnSequence: packet.evidence_end,
        stage: 4, configGeneration: this.config.version,
      });
      const result = { code: receipts.length > 0 ? 'nnm_reconciled' : 'nnm_receipt_timeout', receipts: receipts.length };
      this.state.lastResult = result;
      return result;
    } catch (error) {
      this.store.finish(run.id, signal.aborted ? 'cancelled' : 'failed', {
        resultCode: signal.aborted ? 'activity_cancelled' : (error.code ?? 'nnm_reconciliation_failed'),
        durationMs: performance.now() - started,
      });
      throw error;
    }
  }
  #finishNnmSkipped(run, packet, started, code) {
    this.store.advancePacket(packet.id, 4, code);
    this.store.finish(run.id, 'skipped', { resultCode: code, durationMs: performance.now() - started });
    this.store.commitWatermark({
      runtimeKey: this.runtimeKey, sessionId: null, turnSequence: packet.evidence_end,
      stage: 4, configGeneration: this.config.version,
    });
    const result = { code, packet_id: packet.id };
    this.state.lastResult = result;
    return result;
  }
  async #scanNnmHygiene(packet, { trigger, signal }) {
    const started = performance.now(), since = Date.now();
    const run = this.store.begin({
      runtimeKey: this.runtimeKey, stage: 4, trigger,
      evidenceStart: packet.evidence_start, evidenceEnd: packet.evidence_end,
      inputFingerprint: packet.payload_fingerprint,
    });
    try {
      if (signal.aborted) throw cancelled();
      const engine = this.#engine(), hook = nnmHook(engine.hooks?.health?.());
      if (!hook || !supportsHygiene(hook.version)) {
        return this.#finishHygiene(run, packet, started, 'nnm_hygiene_contract_unavailable');
      }
      const event = engine.eventFactory.create('maintenance.idle', 'maintenance', 'active', {}, {
        cwd: this.config.workspaceRoot, evidence_packet_id: packet.id,
        governance_evidence_id: packet.governance_evidence_id,
      });
      await engine.events.dispatch(event, signal);
      if (signal.aborted) throw cancelled();
      const receipt = await this.nnmHygieneReceipts.latest({ workspaceRoot: this.config.workspaceRoot, since });
      if (!receipt) return this.#finishHygiene(run, packet, started, 'nnm_hygiene_receipt_unavailable');
      const evidence = await admitHygieneReceipt(engine, receipt, this.config.workspaceRoot);
      let candidate = null;
      if (receipt.candidates > 0) candidate = await this.#observeHygieneCandidate(engine, receipt, evidence.id);
      return this.#finishHygiene(run, packet, started, 'nnm_hygiene_scanned', {
        receipt, candidate, state: 'completed', fingerprint: receipt.receipt_id,
      });
    } catch (error) {
      this.store.finish(run.id, signal.aborted ? 'cancelled' : 'failed', {
        resultCode: signal.aborted ? 'activity_cancelled' : (error.code ?? 'nnm_hygiene_failed'),
        durationMs: performance.now() - started,
      });
      throw error;
    }
  }
  async #observeHygieneCandidate(engine, receipt, evidenceId) {
    const registry = new LearningCandidateRegistry({
      store: this.store, governance: engine.governance, runtimeKey: this.runtimeKey,
      scope: { kind: 'workspace', fingerprint: governanceFingerprint(this.config.workspaceRoot) },
      telemetry: engine.telemetry,
    });
    const condition = governanceFingerprint({ candidates: receipt.candidates, categories: receipt.categories });
    return registry.observe({
      id: `candidate-nnm-hygiene-${condition.slice(0, 24)}`,
      kind: 'memory.hygiene_attention', confidence: 1, recurrenceCount: 1,
      evidenceRefs: [evidenceId], expectedBenefit: 'Review deterministic NNM curation candidates without automatic mutation.',
      successCriteria: ['An operator inspects provenance before any explicit memory mutation.'],
      riskClass: 'diagnostic', payload: { candidates: receipt.candidates, categories: receipt.categories },
    });
  }
  #finishHygiene(run, packet, started, code, detail = {}) {
    this.store.finishPacket(packet.id, code);
    this.store.finish(run.id, detail.state ?? 'skipped', {
      resultCode: code, durationMs: performance.now() - started,
      outputFingerprint: detail.fingerprint ?? null,
    });
    this.store.commitWatermark({
      runtimeKey: this.runtimeKey, sessionId: null, turnSequence: packet.evidence_end,
      stage: 0, configGeneration: this.config.version,
    });
    const result = {
      code, packet_id: packet.id, candidates: detail.receipt?.candidates ?? 0,
      candidate_id: detail.candidate?.id ?? null,
    };
    this.state.lastResult = result;
    return result;
  }
  async #newEvidence() {
    const engine = this.#engine(false);
    if (!engine) return [];
    const watermark = this.store.watermark(this.runtimeKey)?.turn_sequence ?? 0;
    const rows = await engine.telemetry.query({ limit: 10_000 });
    return rows.filter((row) => row.id > watermark && row.turn_id && terminalEvidence(row));
  }
  #engine(required = true) {
    const engine = this.workspace.sessions.values().next().value?.engine;
    if (!engine && required) throw Object.assign(new Error('dream engine unavailable'), { code: 'dream_engine_unavailable' });
    return engine;
  }
  #recordStage(event) {
    const telemetry = this.#engine(false)?.telemetry;
    if (!telemetry) return;
    const run = event.run, terminal = event.phase === 'finished';
    telemetry.record('maintenance.stage', terminal ? telemetryStatus(run.state) : 'running', {
      run_id: run.id, stage: run.stage, trigger: run.trigger,
      result_code: run.result_code, duration_ms: run.duration_ms,
      input_fingerprint: run.input_fingerprint, output_fingerprint: run.output_fingerprint,
    }, { reasonCode: run.result_code ?? `stage_${event.phase}` });
  }
  #transcriptRecords() {
    return [...this.workspace.sessions.values()].flatMap((session) => session.engine?.transcript ?? []);
  }
}

function terminalEvidence(row) {
  return ['succeeded', 'failed', 'cancelled', 'timed_out', 'denied', 'skipped', 'unknown_effect'].includes(row.status);
}

function telemetryStatus(state) {
  return state === 'completed' ? 'succeeded' : state;
}

function evidencePacket(rows) {
  const counts = {}, reasons = {}, turns = new Set(), sessions = new Set();
  for (const row of rows) {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
    if (row.reason_code) reasons[row.reason_code] = (reasons[row.reason_code] ?? 0) + 1;
    if (row.turn_id) turns.add(row.turn_id);
    if (row.session_id) sessions.add(row.session_id);
  }
  return {
    records: rows.length, turns: turns.size, sessions: sessions.size, counts, reasons,
    turn_refs: [...turns].slice(-256), session_refs: [...sessions].slice(-64),
    diagnosis: diagnoseDreamEvidence(rows),
  };
}

function workspaceKey(root) { return createHash('sha256').update(root).digest('hex').slice(0, 32); }
function fingerprint(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function cancelled() { return Object.assign(new Error('dream stage cancelled by foreground activity'), { code: 'dream_cancelled' }); }
function reliabilityCandidate(issue, evidenceId) {
  const reason = issue.reason;
  return {
    id: `candidate-recovery-${governanceFingerprint(reason).slice(0, 24)}`,
    kind: 'recovery.failure_pattern', confidence: Math.min(0.95, 0.5 + issue.count * 0.05),
    recurrenceCount: issue.count, evidenceRefs: [evidenceId],
    expectedBenefit: `Reduce repeated ${reason} failures without weakening safety policy.`,
    successCriteria: [
      `A bounded replay of ${reason} completes without the repeated failure.`,
      'Existing safety and regression checks continue to pass.',
    ],
    riskClass: 'diagnostic', payload: { failure_code: reason, proposed_action: 'investigate' },
  };
}

function candidateSummary(candidate, detail = false) {
  const summary = {
    id: candidate.id, kind: candidate.kind, state: candidate.state,
    confidence: Number(candidate.confidence), recurrence_count: Number(candidate.recurrence_count),
    risk_class: candidate.risk_class, expected_benefit: candidate.expected_benefit,
    updated_at: candidate.updated_at,
  };
  if (detail) Object.assign(summary, {
    evidence_refs: candidate.evidence_refs, success_criteria: candidate.success_criteria,
    rejection_reason: candidate.rejection_reason, expires_at: candidate.expires_at,
    payload_fingerprint: candidate.payload_fingerprint, payload: candidate.payload,
  });
  return Object.freeze(summary);
}

function nnmHook(health) {
  return health?.bundles?.find((item) => item.bundle === 'notnative-memory' && item.status === 'loaded') ?? null;
}
function supportsReceipts(version) {
  const parts = String(version ?? '').split('.').map(Number);
  return parts.length === 3 && parts.every(Number.isSafeInteger)
    && (parts[0] > 1 || (parts[0] === 1 && (parts[1] > 5 || (parts[1] === 5 && parts[2] >= 2))));
}
function supportsHygiene(version) {
  const parts = String(version ?? '').split('.').map(Number);
  return parts.length === 3 && parts.every(Number.isSafeInteger)
    && (parts[0] > 1 || (parts[0] === 1 && parts[1] >= 6));
}
async function registerProjectDecisions(engine, decisions, scope, signal) {
  const evidenceRefs = [], sections = {};
  for (const decision of decisions) {
    if (signal.aborted) throw cancelled();
    const contentFingerprint = governanceFingerprint(decision.statement);
    const evidence = await engine.governance.registerEvidence({
      id: `evidence:operator-project-knowledge:${decision.turnId}:${contentFingerprint.slice(0, 24)}`,
      kind: 'operator_project_knowledge', origin: 'operator', trust: 'authority',
      state: 'active', freshness: 'current', conflict: 'none',
      sourceRef: `turn:${decision.turnId}`, sourceFingerprint: decision.turnId,
      contentFingerprint, scope, observedAt: Date.now(),
      attributes: { destination: 'project_memory', section: decision.section },
    });
    evidenceRefs.push(evidence.id);
    (sections[decision.section] ??= []).push(decision.statement);
  }
  return { evidenceRefs, sections };
}
