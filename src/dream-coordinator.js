// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { DreamStore } from './dream-store.js';
import { IdleArbiter } from './idle-arbiter.js';
import { userDataPaths } from './product.js';
import { diagnoseDreamEvidence } from './dream-diagnosis.js';
import { LearningCandidateRegistry } from './learning-candidates.js';
import { governanceFingerprint } from './governance-contracts.js';
import { NnmGovernanceReceipts } from './nnm-governance-receipts.js';

export class DreamCoordinator {
  constructor(options) {
    this.workspace = options.workspace;
    this.config = options.config;
    this.runtimeKey = workspaceKey(this.config.workspaceRoot);
    this.store = options.store ?? new DreamStore({
      path: options.path ?? userDataPaths().dreamState, retentionDays: this.config.dream.retentionDays,
    });
    this.state = { state: 'starting', reason: null, lastResult: null };
    this.nnmReceipts = options.nnmReceipts ?? new NnmGovernanceReceipts({ path: options.nnmReceiptPath });
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
    return {
      enabled: this.config.dream.enabled, state: this.state.state, reason: this.state.reason,
      workspace: this.config.workspaceRoot, watermark: this.store.watermark(this.runtimeKey),
      store: this.store.status(), recent: this.store.recent(10),
    };
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
      // Raw transcript prose is deliberately absent from forensic evidence packets.
      // A future typed user-decision extractor may create a proposal; generic runtime
      // aggregates are never sufficient authority to edit project memory.
      this.store.advancePacket(packet.id, 3, 'project_memory_no_eligible_evidence');
      this.store.finish(run.id, 'skipped', {
        resultCode: 'project_memory_no_eligible_evidence', durationMs: performance.now() - started,
      });
      this.store.commitWatermark({
        runtimeKey: this.runtimeKey, sessionId: null, turnSequence: packet.evidence_end,
        stage: 3, configGeneration: this.config.version,
      });
      const result = { code: 'project_memory_no_eligible_evidence', packet_id: packet.id };
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
      this.store.finishPacket(packet.id, receipts.length > 0 ? 'nnm_reconciled' : 'nnm_receipt_timeout');
      this.store.finish(run.id, receipts.length > 0 ? 'completed' : 'skipped', {
        resultCode: receipts.length > 0 ? 'nnm_reconciled' : 'nnm_receipt_timeout',
        durationMs: performance.now() - started,
        outputFingerprint: fingerprint(receipts.map((item) => item.receipt_id)),
      });
      this.store.commitWatermark({
        runtimeKey: this.runtimeKey, sessionId: null, turnSequence: packet.evidence_end,
        stage: 0, configGeneration: this.config.version,
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
    this.store.finishPacket(packet.id, code);
    this.store.finish(run.id, 'skipped', { resultCode: code, durationMs: performance.now() - started });
    this.store.commitWatermark({
      runtimeKey: this.runtimeKey, sessionId: null, turnSequence: packet.evidence_end,
      stage: 0, configGeneration: this.config.version,
    });
    const result = { code, packet_id: packet.id };
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
}

function terminalEvidence(row) {
  return ['succeeded', 'failed', 'cancelled', 'timed_out', 'denied', 'skipped', 'unknown_effect'].includes(row.status);
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

function nnmHook(health) {
  return health?.bundles?.find((item) => item.bundle === 'notnative-memory' && item.status === 'loaded') ?? null;
}
function supportsReceipts(version) {
  const parts = String(version ?? '').split('.').map(Number);
  return parts.length === 3 && parts.every(Number.isSafeInteger)
    && (parts[0] > 1 || (parts[0] === 1 && (parts[1] > 5 || (parts[1] === 5 && parts[2] >= 2))));
}
async function admitNnmReceipt(engine, receipt, workspaceRoot) {
  const evidenceId = `evidence:nnm-receipt:${receipt.receipt_id}`;
  const evidence = await engine.governance.registerEvidence({
    id: evidenceId, kind: 'nnm_turn_analysis_receipt', origin: 'hook', trust: 'observed',
    state: 'active', freshness: 'current', conflict: 'none', sourceRef: `nnm:${receipt.receipt_id}`,
    sourceFingerprint: receipt.receipt_id, contentFingerprint: governanceFingerprint(receipt),
    scope: { kind: 'workspace', fingerprint: governanceFingerprint(workspaceRoot) },
    observedAt: Date.parse(receipt.completed_at), attributes: {
      stored: receipt.stored, facts_stored: receipt.facts_stored,
      relationships_stored: receipt.relationships_stored, candidates: receipt.candidates,
      summary_stored: receipt.summary_stored,
    },
  });
  const decision = await engine.governance.decide({
    id: `governance:nnm-receipt:${receipt.receipt_id}`, domain: 'memory_eligibility',
    subjectRef: `turn:${receipt.turn_id}`, subjectFingerprint: receipt.receipt_id,
    outcome: 'admit', reasonCode: 'nnm_effect_receipt_verified', policyVersion: 'nnm-reconciliation/1',
    evidenceRefs: [evidence.id], authorityRefs: [], decidedAt: Date.parse(receipt.completed_at),
    expiresAt: null, attributes: { stored: receipt.stored, candidates: receipt.candidates },
  });
  await engine.governance.settleDecision(decision.id, {
    status: 'applied', effectCertainty: 'completed', resultFingerprint: receipt.receipt_id,
    reasonCode: 'nnm_effects_attributed',
  });
}
