// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { ContractError } from './ids.js';
import { JournalStore } from './store.js';

export class ReviewerLedger {
  #entries = new Map();
  #store = null;

  constructor(options) {
    this.retentionEntries = options.retentionEntries ?? 10_000;
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
    for (const record of recovered.records.slice(0, 1_000_000)) this.#apply(record.type, record.payload);
    await this.#enforceRetention();
  }

  async propose(request, classification) {
    const existing = this.#entries.get(request.id);
    if (existing) return existing;
    const entry = {
      requestId: request.id, signature: operationSignature(request), toolName: request.toolName,
      targetFingerprint: fingerprint(targetIdentity(request)), classification,
      decision: null, execution: null, repetition: this.#repetitionCount(request),
    };
    await this.#record('proposal', entry);
    this.#entries.set(request.id, entry);
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

  summary(request, limit = 16) {
    const signature = operationSignature(request);
    return [...this.#entries.values()].filter((entry) => entry.signature === signature)
      .slice(-limit).map((entry) => ({
        classification: entry.classification.risk, decision: entry.decision?.outcome ?? null,
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
    return [...this.#entries.values()].filter((entry) => entry.signature === signature).length;
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
    const retained = [...this.#entries.values()].slice(-this.retentionEntries);
    if (this.#store) await this.#store.replace(retained.flatMap(entryRecords));
    this.#entries = new Map(retained.map((entry) => [entry.requestId, entry]));
  }

  #apply(type, payload) {
    if (type === 'proposal') this.#entries.set(payload.requestId, payload);
    if (type === 'decision') this.#require(payload.requestId).decision = payload.decision;
    if (type === 'operator_decision') this.#require(payload.requestId).decision = payload.decision;
    if (type === 'execution_started') this.#require(payload.requestId).execution = payload.execution;
    if (type === 'execution_terminal') {
      const execution = this.#require(payload.requestId).execution;
      execution.status = payload.terminal.status;
      execution.terminal = payload.terminal;
    }
  }
}

function entryRecords(entry) {
  const records = [{ type: 'proposal', payload: { ...entry, decision: null, execution: null } }];
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
    policyVersion: request.policyVersion,
    definitionVersion: request.definitionVersion,
  };
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
}

function targetIdentity(request) {
  if (typeof request.resolved?.path === 'string') return request.resolved.path;
  return stableJson(request.resolved ?? request.args ?? { tool: request.toolName });
}
