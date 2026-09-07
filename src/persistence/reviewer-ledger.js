// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { ContractError } from '../ids.js';
import { JournalStore } from '../store.js';
import { retentionCompactionTarget, validateRetentionLimit } from './retention.js';

const DEFAULT_RETENTION_ENTRIES = 10_000;
const MAX_REPLAY_RECORDS = 1_000_000;
const MAX_COMPLETION_REQUESTS = 64;

export class ReviewerLedger {
  #entries = new Map();
  #signatureCounts = new Map();
  #store = null;

  constructor(options) {
    this.retentionEntries = validateRetentionLimit(options.retentionEntries ?? DEFAULT_RETENTION_ENTRIES);
    if (options.durable) this.#store = new JournalStore(options.root, `${options.sessionId}.review`, {
      persistenceDeadlineMs: options.persistenceDeadlineMs,
    });
  }

  async initialize() {
    if (!this.#store) return;
    const recovered = await this.#store.open();
    if (recovered.corruptTail) {
      throw new ContractError('reviewer_ledger_corrupt', 'reviewer ledger has a corrupt tail');
    }
    for (const record of recovered.records.slice(0, MAX_REPLAY_RECORDS)) this.#apply(record.type, record.payload);
    await this.#enforceRetention();
  }

  async propose(request, classification, causal = {}) {
    const existing = this.#entries.get(request.id);
    if (existing) return existing;
    const entry = {
      requestId: request.id, signature: operationSignature(request), toolName: request.toolName,
      targetFingerprint: fingerprint(targetIdentity(request)), classification,
      operationFingerprint: completionOperationFingerprint(request),
      turnId: boundedIdentity(causal.turnId), operatorRequestId: boundedIdentity(causal.operatorRequestId),
      decision: null, execution: null, repetition: this.#repetitionCount(request),
    };
    await this.#record('proposal', entry);
    this.#addEntry(entry);
    return entry;
  }

  async commitDecision(requestId, decision) {
    const entry = this.#require(requestId);
    if (entry.decision) return entry.decision;
    await this.#record('decision', { requestId, decision });
    entry.decision = decision;
    return decision;
  }

  async commitOperatorDecision(requestId, decision) {
    const entry = this.#require(requestId);
    if (entry.decision?.outcome !== 'escalate_to_operator') {
      throw new ContractError('operator_decision_unexpected', 'operator decision requires a committed escalation');
    }
    await this.#record('operator_decision', { requestId, decision });
    entry.decision = decision;
    return decision;
  }

  async executionStarted(requestId, decisionId) {
    const entry = this.#require(requestId);
    if (entry.execution) throw new ContractError('ledger_execution_duplicate', 'execution was already accounted');
    const execution = { decisionId, status: 'running', terminal: null };
    await this.#record('execution_started', { requestId, execution });
    entry.execution = execution;
  }

  async settle(requestId, terminal) {
    const entry = this.#require(requestId);
    if (!entry.execution) throw new ContractError('ledger_start_missing', 'execution start is missing');
    if (entry.execution.terminal) return entry.execution.terminal;
    await this.#record('execution_terminal', { requestId, terminal });
    entry.execution.status = terminal.status;
    entry.execution.terminal = terminal;
    await this.#enforceRetention();
    return terminal;
  }

  execution(requestId) {
    const execution = this.#entries.get(requestId)?.execution;
    return execution ? Object.freeze({
      decisionId: execution.decisionId,
      status: execution.status,
      terminal: execution.terminal ? Object.freeze({ ...execution.terminal }) : null,
    }) : null;
  }

  summary(request, limit = 16) {
    const signature = operationSignature(request);
    return [...this.#entries.values()].filter((entry) => entry.signature === signature)
      .slice(-limit).map((entry) => ({
        classification: entry.classification.risk, decision: entry.decision?.outcome ?? null,
        reasonCode: entry.decision?.reasonCode ?? null,
        result: entry.execution?.terminal?.status ?? null, repetition: entry.repetition,
      }));
  }

  audit(limit = 100) {
    return [...this.#entries.values()].slice(-limit).map((entry) => ({
      request_id: entry.requestId, tool: entry.toolName,
      risk: entry.classification.risk, scope: entry.classification.scope,
      decision: entry.decision?.outcome ?? null, reason: entry.decision?.reasonCode ?? null,
      result: entry.execution?.terminal?.status ?? null,
      effect: entry.classification.effect, complexity: entry.classification.complexity,
      decision_provenance: entry.decision?.provenance ?? 'mandatory_reviewer',
      boundary_revalidation: entry.execution ? 'passed' : 'not_executed',
      elapsed_ms: entry.execution?.terminal?.elapsed_ms ?? null,
      effect_certainty: entry.execution?.terminal?.effect_certainty ?? 'none',
      target_fingerprint: entry.targetFingerprint, repetition: entry.repetition,
    }));
  }

  completionState(options = {}) {
    const turnIds = boundedIdentitySet(options.turnIds);
    const requestIds = boundedIdentitySet(options.requestIds);
    const entries = [...this.#entries.values()];
    const latestSuccess = new Map();
    for (let index = 0; index < entries.length; index += 1) {
      if (confirmedExecution(entries[index])) latestSuccess.set(entries[index].operationFingerprint, index);
    }
    const selected = [];
    let unresolvedCount = 0;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry.toolName === 'turn_finish' || (!turnIds.has(entry.turnId) && !requestIds.has(entry.requestId))) continue;
      if (settledOutcome(entry) || (latestSuccess.get(entry.operationFingerprint) ?? -1) > index) continue;
      unresolvedCount += 1;
      if (selected.length < MAX_COMPLETION_REQUESTS) selected.push(completionEntry(entry));
    }
    return Object.freeze({
      schema: 'nna.reviewer-completion.v1', inspected_entries: entries.length,
      unresolved_count: unresolvedCount, unresolved_truncated: unresolvedCount > selected.length,
      unresolved: Object.freeze(selected),
    });
  }

  health() {
    return Object.freeze({
      status: 'ready', entries: this.#entries.size, durable: this.#store !== null,
      retention_entries: this.retentionEntries,
    });
  }

  async close() {
    await this.#store?.close();
  }

  #repetitionCount(request) {
    const signature = operationSignature(request);
    return this.#signatureCounts.get(signature) ?? 0;
  }

  #addEntry(entry) {
    const replaced = this.#entries.get(entry.requestId);
    if (replaced) {
      const priorCount = this.#signatureCounts.get(replaced.signature) ?? 1;
      if (priorCount <= 1) this.#signatureCounts.delete(replaced.signature);
      else this.#signatureCounts.set(replaced.signature, priorCount - 1);
    }
    this.#entries.set(entry.requestId, entry);
    this.#signatureCounts.set(entry.signature, (this.#signatureCounts.get(entry.signature) ?? 0) + 1);
  }

  #require(requestId) {
    const entry = this.#entries.get(requestId);
    if (!entry) throw new ContractError('ledger_proposal_missing', 'reviewer proposal is missing');
    return entry;
  }

  async #record(type, payload) {
    if (this.#store) await this.#store.append(type, payload);
  }

  async #enforceRetention() {
    if (this.#entries.size <= this.retentionEntries) return;
    const retained = [...this.#entries.values()].slice(-retentionCompactionTarget(this.retentionEntries));
    if (this.#store) await this.#store.replace(retained.flatMap(entryRecords));
    const retainedEntries = new Map(retained.map((entry) => [entry.requestId, entry]));
    const retainedSignatureCounts = new Map();
    for (const entry of retained) {
      retainedSignatureCounts.set(entry.signature, (retainedSignatureCounts.get(entry.signature) ?? 0) + 1);
    }
    this.#entries = retainedEntries;
    this.#signatureCounts = retainedSignatureCounts;
  }

  #apply(type, payload) {
    switch (type) {
      case 'proposal':
        payload.operationFingerprint ??= legacyCompletionFingerprint(payload);
        payload.turnId ??= null;
        payload.operatorRequestId ??= null;
        this.#addEntry(payload);
        break;
      case 'decision':
      case 'operator_decision':
        this.#require(payload.requestId).decision = payload.decision;
        break;
      case 'execution_started':
        this.#require(payload.requestId).execution = payload.execution;
        break;
      case 'execution_terminal': {
        const execution = this.#require(payload.requestId).execution;
        if (!execution) {
          throw new ContractError('ledger_start_missing', 'execution terminal has no preceding execution start');
        }
        execution.status = payload.terminal.status;
        execution.terminal = payload.terminal;
        break;
      }
      default:
        throw new ContractError('reviewer_record_unknown', `unknown reviewer ledger record type: ${type}`);
    }
  }
}

function entryRecords(entry) {
  const records = [{ type: 'proposal', payload: {
    requestId: entry.requestId,
    signature: entry.signature,
    toolName: entry.toolName,
    targetFingerprint: entry.targetFingerprint,
    operationFingerprint: entry.operationFingerprint,
    turnId: entry.turnId,
    operatorRequestId: entry.operatorRequestId,
    classification: entry.classification,
    repetition: entry.repetition,
    decision: null,
    execution: null,
  } }];
  if (entry.decision) records.push({ type: 'decision', payload: { requestId: entry.requestId, decision: entry.decision } });
  if (entry.execution) {
    records.push({ type: 'execution_started', payload: {
      requestId: entry.requestId,
      execution: { decisionId: entry.execution.decisionId, status: 'running', terminal: null },
    } });
    if (entry.execution.terminal) records.push({
      type: 'execution_terminal', payload: { requestId: entry.requestId, terminal: entry.execution.terminal },
    });
  }
  return records;
}

export function requestDigest(request) {
  const value = {
    id: request.id, toolName: request.toolName, args: request.args,
    resolved: request.resolved, authorityId: request.authorityId,
    policyVersion: request.policyVersion, definitionVersion: request.definitionVersion,
  };
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export function operationSignature(request) {
  const value = {
    toolName: request.toolName, args: request.args, resolved: request.resolved,
    authorityId: request.authorityId, authorityVersion: request.authorityVersion,
    authorityRestrictionVersion: request.authorityRestrictionVersion ?? 0,
    stateRevision: request.stateRevision ?? 0,
    policyVersion: request.policyVersion,
    definitionVersion: request.definitionVersion,
  };
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function completionOperationFingerprint(request) {
  return fingerprint(stableJson({ toolName: request.toolName, args: request.args, target: targetIdentity(request) }));
}

function legacyCompletionFingerprint(entry) {
  // Compatibility: older durable entries have no causal completion identity. Keep them
  // auditable, but do not let incomplete historical data become a completion gate.
  return `legacy:${entry.requestId}`;
}

function boundedIdentity(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
}

function boundedIdentitySet(values) {
  if (!Array.isArray(values)) return new Set();
  return new Set(values.slice(0, MAX_COMPLETION_REQUESTS).map(boundedIdentity).filter(Boolean));
}

function confirmedExecution(entry) {
  const terminal = entry.execution?.terminal;
  return terminal?.status === 'succeeded' && ['completed', 'none'].includes(terminal.effect_certainty);
}

function settledOutcome(entry) {
  if (confirmedExecution(entry)) return true;
  const terminal = entry.execution?.terminal;
  // Why: an invalid request with no effect is repair feedback, not unfinished execution.
  return terminal?.status === 'invalid_request' && terminal.effect_certainty === 'none';
}

function completionEntry(entry) {
  const terminal = entry.execution?.terminal;
  const decision = entry.decision?.outcome ?? null;
  const state = !decision ? 'review_pending'
    : decision !== 'approve' ? 'not_approved'
      : !entry.execution ? 'not_executed'
        : !terminal ? 'running' : terminal.status;
  return Object.freeze({
    request_id: entry.requestId, origin_turn_id: entry.turnId, tool: entry.toolName,
    operation_fingerprint: entry.operationFingerprint, state,
    reason_code: terminal?.reason_code ?? entry.decision?.reasonCode ?? null,
    effect_certainty: terminal?.effect_certainty ?? 'none',
  });
}

function stableJson(value, ancestors = new WeakSet()) {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (ancestors.has(value)) {
    throw new ContractError('reviewer_request_circular', 'reviewer request contains a circular reference');
  }
  ancestors.add(value);
  let serialized;
  if (Array.isArray(value)) {
    serialized = `[${value.map((item) => stableJson(item, ancestors)).join(',')}]`;
  } else {
    serialized = `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key], ancestors)}`).join(',')}}`;
  }
  ancestors.delete(value);
  return serialized;
}

function fingerprint(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
}

function targetIdentity(request) {
  if (typeof request.resolved?.path === 'string') return request.resolved.path;
  return stableJson(request.resolved ?? request.args ?? { tool: request.toolName });
}
