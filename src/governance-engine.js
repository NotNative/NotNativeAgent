// SPDX-License-Identifier: Apache-2.0
import { ContractError, newId } from './ids.js';
import { JournalStore } from './store.js';
import { retentionCompactionTarget, validateRetentionLimit } from './persistence/retention.js';
import {
  assertEvidenceTransition, governanceFingerprint, normalizeGovernanceDecision,
  normalizeGovernanceEvidence, normalizeGovernanceTerminal,
} from './governance/contracts.js';

const DEFAULT_RETENTION_ENTRIES = 20_000;
const MINIMUM_RESUME_RECORDS = 10_000;
const MAX_AUDIT_ENTRIES = 1_000;
const DEFAULT_AUDIT_ENTRIES = 100;
const MAX_GOVERNANCE_ATTRIBUTES = 32;
const POLICY_TRANSITION_REASON = 'policy_transition';
const ACTION_AUTHORIZATION_DOMAIN = 'action_authorization';
const GUIDANCE_PROMOTION_DOMAIN = 'guidance_promotion';
const LEARNING_PROMOTION_DOMAIN = 'learning_promotion';
const QUARANTINED_STATE = 'quarantined';
const CONFLICTING_STATE = 'conflicting';
const APPROVED_OUTCOMES = Object.freeze(['approve', 'admit', 'promote']);
const DENIED_OUTCOMES = Object.freeze(['deny_with_guidance', 'hard_deny', 'reject', 'quarantine']);

export class GovernanceEngine {
  #evidence = new Map();
  #decisions = new Map();
  #store = null;

  constructor(options) {
    this.telemetry = options.telemetry ?? null;
    this.sessionId = options.sessionId;
    this.retentionEntries = validateRetentionLimit(options.retentionEntries ?? DEFAULT_RETENTION_ENTRIES, 25_000);
    if (options.durable) this.#store = new JournalStore(options.root, `${this.sessionId}.governance`, {
      persistenceDeadlineMs: options.persistenceDeadlineMs,
      resumeRecordLimit: Math.max(this.retentionEntries * 4, MINIMUM_RESUME_RECORDS),
    });
  }

  async initialize() {
    if (!this.#store) return this.health();
    const recovered = await this.#store.open();
    if (recovered.corruptTail) {
      throw new ContractError('governance_journal_corrupt', 'governance journal has a corrupt tail');
    }
    for (const record of recovered.records) this.#apply(record.type, record.payload);
    await this.#enforceRetention();
    return this.health();
  }

  async registerEvidence(input) {
    const evidence = normalizeGovernanceEvidence({ ...input, id: input.id ?? newId('evidence') });
    const existing = this.#evidence.get(evidence.id);
    if (existing) {
      if (governanceFingerprint(existing.record) !== governanceFingerprint(evidence)) {
        return this.#recoverEvidenceDrift(evidence);
      }
      return existing.record;
    }
    await this.#record('evidence_registered', { evidence });
    this.#evidence.set(evidence.id, { record: evidence, history: [] });
    this.#telemetry('governance.evidence', 'succeeded', evidence, { evidence_id: evidence.id });
    await this.#enforceRetention(evidence.id);
    return evidence;
  }

  async transitionEvidence(id, state, detail = {}) {
    const entry = this.#requireEvidence(id);
    assertEvidenceTransition(entry.record.state, state);
    const transition = Object.freeze({
      id, from: entry.record.state, to: state, at: Date.now(),
      reasonCode: detail.reasonCode ?? POLICY_TRANSITION_REASON,
      evidenceRefs: Object.freeze([...(detail.evidenceRefs ?? [])]),
    });
    await this.#record('evidence_transitioned', { transition });
    this.#apply('evidence_transitioned', { transition });
    this.#telemetry('governance.evidence', 'succeeded', transition, { evidence_id: id, reason_code: transition.reasonCode });
    return this.#evidence.get(id).record;
  }

  async decide(input) {
    const decision = normalizeGovernanceDecision({ ...input, id: input.id ?? newId('governance_decision') });
    const existing = this.#decisions.get(decision.id);
    if (existing) {
      if (governanceFingerprint(existing.record) !== governanceFingerprint(decision)) {
        return this.#recoverDecisionDrift(decision);
      }
      return existing.record;
    }
    for (const evidenceId of decision.evidenceRefs) this.#requireEvidence(evidenceId);
    await this.#record('decision_committed', { decision });
    this.#decisions.set(decision.id, { record: decision, terminal: null });
    this.#telemetry('governance.decision', decisionStatus(decision.outcome), decision, {
      governance_decision_id: decision.id, reason_code: decision.reasonCode,
    });
    await this.#enforceRetention();
    return decision;
  }

  async settleDecision(id, input) {
    const entry = this.#requireDecision(id);
    if (entry.terminal) return entry.terminal;
    const terminal = normalizeGovernanceTerminal(input);
    await this.#record('decision_settled', { id, terminal });
    entry.terminal = terminal;
    this.#telemetry('governance.effect', terminalStatus(terminal.status), terminal, {
      governance_decision_id: id, reason_code: terminal.reasonCode,
    });
    return terminal;
  }

  async recordAuthorization(request, decision, context = {}) {
    const scope = { kind: 'workspace', fingerprint: governanceFingerprint(request.workspaceRoot) };
    const requestEvidence = await this.registerEvidence({
      id: `evidence:request:${request.id}`, kind: 'tool_request', origin: 'runtime', trust: 'observed',
      state: 'active', freshness: 'current', conflict: 'none', sourceRef: request.id,
      sourceFingerprint: decision.requestDigest, contentFingerprint: decision.requestDigest,
      scope, observedAt: request.createdAt,
      attributes: { tool_name: request.toolName, side_effect: context.definition?.sideEffect ?? 'unknown' },
    });
    const authorityMaterial = governanceFingerprint(JSON.stringify({
      id: decision.authorityId,
      version: decision.authorityVersion,
      restrictionVersion: decision.authorityRestrictionVersion,
      intent: context.authority?.intent ?? [],
      mission: context.authority?.mission ?? null,
      complete: context.authority?.complete ?? null,
    }));
    const authorityEvidence = await this.registerEvidence({
      id: `evidence:authority:${governanceFingerprint(`${request.id}:${decision.authorityId}:${decision.authorityVersion}:${decision.authorityRestrictionVersion}:${authorityMaterial}`)}`,
      kind: 'authenticated_intent', origin: 'operator', trust: 'authority',
      state: 'active', freshness: 'current', conflict: 'none',
      sourceRef: decision.authorityId, sourceFingerprint: authorityMaterial,
      contentFingerprint: authorityMaterial, scope, observedAt: request.createdAt,
      attributes: {
        authority_version: decision.authorityVersion,
        restriction_version: decision.authorityRestrictionVersion,
        complete: context.authority?.complete ?? null,
      },
    });
    return this.decide({
      id: decision.id,
      domain: ACTION_AUTHORIZATION_DOMAIN,
      subjectRef: request.id,
      subjectFingerprint: decision.requestDigest,
      outcome: decision.outcome,
      reasonCode: decision.reasonCode,
      policyVersion: String(decision.policyVersion),
      evidenceRefs: [requestEvidence.id, authorityEvidence.id],
      authorityRefs: [authorityEvidence.id],
      decidedAt: decision.committedAt,
      expiresAt: decision.expiresAt,
      attributes: {
        tool_name: request.toolName,
        authority_version: decision.authorityVersion,
        restriction_version: decision.authorityRestrictionVersion,
      },
    });
  }

  evidence(id) { return this.#evidence.get(id)?.record ?? null; }
  evidenceBySource(sourceRef) {
    return Object.freeze([...this.#evidence.values()]
      .map((entry) => entry.record).filter((record) => record.sourceRef === sourceRef));
  }
  decision(id) { return this.#decisions.get(id)?.record ?? null; }

  audit(limit = DEFAULT_AUDIT_ENTRIES) {
    const bounded = Number.isSafeInteger(limit)
      ? Math.max(1, Math.min(MAX_AUDIT_ENTRIES, limit))
      : DEFAULT_AUDIT_ENTRIES;
    return Object.freeze([...this.#decisions.values()].slice(-bounded).map((entry) => Object.freeze({
      ...entry.record, terminal: entry.terminal,
    })));
  }

  health() {
    const states = {};
    const kinds = {};
    const domains = {};
    const outcomes = {};
    let unsettled = 0;
    let uncertainEffects = 0;
    for (const entry of this.#evidence.values()) states[entry.record.state] = (states[entry.record.state] ?? 0) + 1;
    for (const entry of this.#evidence.values()) kinds[entry.record.kind] = (kinds[entry.record.kind] ?? 0) + 1;
    for (const entry of this.#decisions.values()) {
      domains[entry.record.domain] = (domains[entry.record.domain] ?? 0) + 1;
      outcomes[entry.record.outcome] = (outcomes[entry.record.outcome] ?? 0) + 1;
      if (!entry.terminal) {
        if (settlementRequired(entry.record)) unsettled += 1;
      } else if (entry.terminal.effectCertainty === 'unknown' || entry.terminal.status === 'unknown_effect') {
        uncertainEffects += 1;
      }
    }
    const pendingEvidence = [...this.#evidence.values()].filter((entry) =>
      entry.record.state === QUARANTINED_STATE && entry.record.kind === 'improvement_candidate').length;
    const attentionEvidence = (states[QUARANTINED_STATE] ?? 0) - pendingEvidence
      + (states[CONFLICTING_STATE] ?? 0);
    return Object.freeze({
      status: attentionEvidence > 0 || uncertainEffects > 0 || unsettled > 0 ? 'attention' : 'ready',
      durable: this.#store !== null, evidence: this.#evidence.size,
      decisions: this.#decisions.size, evidence_states: Object.freeze(states),
      evidence_kinds: Object.freeze(kinds), decisions_by_domain: Object.freeze(domains),
      decision_outcomes: Object.freeze(outcomes), unsettled_decisions: unsettled,
      uncertain_effects: uncertainEffects, attention_evidence: attentionEvidence,
      pending_evidence: pendingEvidence,
      retention_entries: this.retentionEntries,
    });
  }

  async close() { await this.#store?.close(); }

  // Identity reuse with different content is a drift, but throwing here left the
  // session permanently unrecoverable: the durable journal replays the original
  // record forever, so every later turn that recomputes the same deterministic id
  // failed again. Instead, rebase the drifted record onto a replacement id derived
  // from (original id, content) — deterministic, so a retried turn converges on the
  // same record — and keep the collision auditable via supersedes, the suspected
  // conflict marker, and a recovered telemetry event. The original record is never
  // mutated.
  async #recoverEvidenceDrift(evidence) {
    const driftId = `evidence:drift:${governanceFingerprint(`${evidence.id}:${governanceFingerprint(evidence)}`)}`;
    this.#telemetry('governance.evidence', 'recovered', evidence, {
      evidence_id: driftId, reason_code: 'governance_evidence_drift',
    });
    return this.registerEvidence({
      ...evidence,
      id: driftId,
      conflict: evidence.conflict === 'none' ? 'suspected' : evidence.conflict,
      supersedes: [...evidence.supersedes.slice(-63), evidence.id],
    });
  }

  async #recoverDecisionDrift(decision) {
    const driftId = `governance_decision:drift:${governanceFingerprint(`${decision.id}:${governanceFingerprint(decision)}`)}`;
    this.#telemetry('governance.decision', 'recovered', decision, {
      governance_decision_id: driftId, reason_code: 'governance_decision_drift',
    });
    const retainedAttributes = Object.entries(decision.attributes)
      .filter(([key]) => key !== 'drift_of')
      .slice(0, MAX_GOVERNANCE_ATTRIBUTES - 1);
    const attributes = { ...Object.fromEntries(retainedAttributes), drift_of: decision.id };
    return this.decide({ ...decision, id: driftId, attributes });
  }

  #requireEvidence(id) {
    const entry = this.#evidence.get(id);
    if (!entry) throw new ContractError('governance_evidence_missing', 'referenced evidence does not exist');
    return entry;
  }

  #requireDecision(id) {
    const entry = this.#decisions.get(id);
    if (!entry) throw new ContractError('governance_decision_missing', 'governance decision does not exist');
    return entry;
  }

  async #record(type, payload) { if (this.#store) await this.#store.append(type, payload); }

  #apply(type, payload) {
    switch (type) {
      case 'evidence_registered':
        this.#evidence.set(payload.evidence.id, { record: payload.evidence, history: [] });
        break;
      case 'evidence_transitioned': {
        const entry = this.#requireEvidence(payload.transition.id);
        entry.history.push(payload.transition);
        entry.record = Object.freeze({ ...entry.record, state: payload.transition.to });
        break;
      }
      case 'decision_committed':
        this.#decisions.set(payload.decision.id, { record: payload.decision, terminal: null });
        break;
      case 'decision_settled':
        this.#requireDecision(payload.id).terminal = payload.terminal;
        break;
      default:
        throw new ContractError('governance_record_unknown', `unknown governance record type: ${type}`);
    }
  }

  async #enforceRetention(pinnedEvidenceId = null) {
    const total = this.#evidence.size + this.#decisions.size;
    if (total <= this.retentionEntries) return;
    const retentionTarget = retentionCompactionTarget(this.retentionEntries);
    const allDecisions = [...this.#decisions.values()];
    const decisions = [];
    const requiredEvidence = new Set(pinnedEvidenceId ? [pinnedEvidenceId] : []);
    for (let index = allDecisions.length - 1; index >= 0; index -= 1) {
      const candidate = allDecisions[index];
      const additions = candidate.record.evidenceRefs.filter((id) => !requiredEvidence.has(id));
      if (decisions.length + requiredEvidence.size + additions.length + 1 > retentionTarget) break;
      decisions.push(candidate);
      for (const id of additions) requiredEvidence.add(id);
    }
    const retainedDecisions = decisions.toReversed();
    const evidenceBudget = retentionTarget - retainedDecisions.length;
    const allEvidence = [...this.#evidence.values()];
    const optional = allEvidence.filter((entry) => !requiredEvidence.has(entry.record.id));
    const optionalBudget = Math.max(0, evidenceBudget - requiredEvidence.size);
    const retainedIds = new Set([
      ...requiredEvidence,
      ...(optionalBudget > 0 ? optional.slice(-optionalBudget) : []).map((entry) => entry.record.id),
    ]);
    const evidence = allEvidence.filter((entry) => retainedIds.has(entry.record.id));
    if (this.#store) await this.#store.replace([
      ...evidence.flatMap(evidenceRecords), ...retainedDecisions.flatMap(decisionRecords),
    ]);
    this.#evidence = new Map(evidence.map((entry) => [entry.record.id, entry]));
    this.#decisions = new Map(retainedDecisions.map((entry) => [entry.record.id, entry]));
  }

  #telemetry(event, status, payload, correlation) {
    this.telemetry?.record(event, status, payload, correlation);
  }
}

function evidenceRecords(entry) {
  return [
    { type: 'evidence_registered', payload: { evidence: { ...entry.record, state: entry.history[0]?.from ?? entry.record.state } } },
    ...entry.history.map((transition) => ({ type: 'evidence_transitioned', payload: { transition } })),
  ];
}

function decisionRecords(entry) {
  const records = [{ type: 'decision_committed', payload: { decision: entry.record } }];
  if (entry.terminal) records.push({ type: 'decision_settled', payload: { id: entry.record.id, terminal: entry.terminal } });
  return records;
}

function decisionStatus(outcome) {
  return APPROVED_OUTCOMES.includes(outcome) ? 'succeeded'
    : DENIED_OUTCOMES.includes(outcome) ? 'denied' : 'skipped';
}

function terminalStatus(status) {
  if (status === 'applied') return 'succeeded';
  if (status === 'not_applied') return 'skipped';
  return status;
}

function settlementRequired(decision) {
  if (decision.domain === ACTION_AUTHORIZATION_DOMAIN) return true;
  return [GUIDANCE_PROMOTION_DOMAIN, LEARNING_PROMOTION_DOMAIN].includes(decision.domain)
    && decision.outcome === 'promote';
}
