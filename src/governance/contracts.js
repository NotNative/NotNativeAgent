// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { ContractError } from '../ids.js';

export const GOVERNANCE_DOMAINS = Object.freeze([
  'action_authorization', 'evidence_admission', 'memory_eligibility',
  'guidance_promotion', 'learning_promotion', 'claim_support',
]);

export const EVIDENCE_STATES = Object.freeze([
  'active', 'stale', 'conflicting', 'quarantined', 'superseded', 'invalidated', 'expired',
]);

const DOMAINS = new Set(GOVERNANCE_DOMAINS);
const STATES = new Set(EVIDENCE_STATES);
const ORIGINS = new Set([
  'operator', 'kernel', 'runtime', 'local_observation', 'tool_result', 'retrieval',
  'memory', 'workspace_guidance', 'hook', 'model', 'external',
]);
const TRUST = new Set(['authority', 'kernel', 'observed', 'configured', 'untrusted']);
const FRESHNESS = new Set(['current', 'aging', 'stale', 'unknown', 'not_applicable']);
const CONFLICT = new Set(['none', 'suspected', 'confirmed', 'resolved']);
const OUTCOMES = new Set([
  'admit', 'reject', 'quarantine', 'approve', 'deny_with_guidance', 'hard_deny',
  'escalate_to_operator', 'promote', 'supersede', 'invalidate', 'defer',
]);
const TERMINALS = new Set(['applied', 'not_applied', 'failed', 'cancelled', 'unknown_effect']);

export function normalizeGovernanceEvidence(input) {
  object(input, 'governance_evidence_invalid');
  exactKeys(input, EVIDENCE_KEYS, 'governance evidence');
  const evidence = {
    id: identifier(input.id, 'evidence id'),
    kind: identifier(input.kind, 'evidence kind'),
    origin: member(input.origin, ORIGINS, 'evidence origin'),
    trust: member(input.trust, TRUST, 'evidence trust'),
    state: member(input.state ?? 'active', STATES, 'evidence state'),
    freshness: member(input.freshness ?? 'unknown', FRESHNESS, 'evidence freshness'),
    conflict: member(input.conflict ?? 'none', CONFLICT, 'evidence conflict'),
    sourceRef: reference(input.sourceRef, 'source reference'),
    sourceFingerprint: digestValue(input.sourceFingerprint ?? input.sourceRef),
    contentFingerprint: digestValue(input.contentFingerprint),
    scope: normalizeScope(input.scope),
    observedAt: timestamp(input.observedAt ?? Date.now(), 'observed timestamp'),
    validFrom: nullableTimestamp(input.validFrom),
    validUntil: nullableTimestamp(input.validUntil),
    supersedes: references(input.supersedes),
    attributes: scalarAttributes(input.attributes),
  };
  if (evidence.validFrom !== null && evidence.validUntil !== null && evidence.validUntil < evidence.validFrom) {
    throw new ContractError('governance_evidence_validity_invalid', 'evidence validity ends before it begins');
  }
  return Object.freeze(evidence);
}

export function normalizeGovernanceDecision(input) {
  object(input, 'governance_decision_invalid');
  exactKeys(input, DECISION_KEYS, 'governance decision');
  return Object.freeze({
    id: identifier(input.id, 'decision id'),
    domain: member(input.domain, DOMAINS, 'governance domain'),
    subjectRef: reference(input.subjectRef, 'decision subject'),
    subjectFingerprint: digestValue(input.subjectFingerprint),
    outcome: member(input.outcome, OUTCOMES, 'decision outcome'),
    reasonCode: identifier(input.reasonCode, 'decision reason'),
    policyVersion: reference(input.policyVersion, 'policy version'),
    evidenceRefs: references(input.evidenceRefs),
    authorityRefs: references(input.authorityRefs),
    decidedAt: timestamp(input.decidedAt ?? Date.now(), 'decision timestamp'),
    expiresAt: nullableTimestamp(input.expiresAt),
    attributes: scalarAttributes(input.attributes),
  });
}

export function normalizeGovernanceTerminal(input) {
  object(input, 'governance_terminal_invalid');
  exactKeys(input, TERMINAL_KEYS, 'governance terminal');
  return Object.freeze({
    status: member(input.status, TERMINALS, 'decision terminal status'),
    effectCertainty: member(input.effectCertainty ?? 'none', new Set(['none', 'completed', 'unknown']), 'effect certainty'),
    resultFingerprint: digestValue(input.resultFingerprint),
    settledAt: timestamp(input.settledAt ?? Date.now(), 'terminal timestamp'),
    reasonCode: input.reasonCode === null || input.reasonCode === undefined
      ? null : identifier(input.reasonCode, 'terminal reason'),
  });
}

export function assertEvidenceTransition(current, next) {
  member(current, STATES, 'current evidence state');
  member(next, STATES, 'next evidence state');
  const allowed = TRANSITIONS[current];
  if (current === next || !allowed?.has(next)) {
    throw new ContractError('governance_evidence_transition_invalid', `evidence cannot transition from ${current} to ${next}`);
  }
}

export function governanceFingerprint(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

const TRANSITIONS = Object.freeze({
  active: new Set(['stale', 'conflicting', 'quarantined', 'superseded', 'invalidated', 'expired']),
  stale: new Set(['active', 'conflicting', 'quarantined', 'superseded', 'invalidated', 'expired']),
  conflicting: new Set(['active', 'stale', 'quarantined', 'superseded', 'invalidated']),
  quarantined: new Set(['active', 'stale', 'conflicting', 'superseded', 'invalidated', 'expired']),
  superseded: new Set(['invalidated', 'expired']),
  invalidated: new Set([]),
  expired: new Set(['invalidated']),
});

const EVIDENCE_KEYS = new Set([
  'id', 'kind', 'origin', 'trust', 'state', 'freshness', 'conflict', 'sourceRef',
  'sourceFingerprint', 'contentFingerprint', 'scope', 'observedAt', 'validFrom',
  'validUntil', 'supersedes', 'attributes',
]);
const DECISION_KEYS = new Set([
  'id', 'domain', 'subjectRef', 'subjectFingerprint', 'outcome', 'reasonCode',
  'policyVersion', 'evidenceRefs', 'authorityRefs', 'decidedAt', 'expiresAt', 'attributes',
]);
const TERMINAL_KEYS = new Set([
  'status', 'effectCertainty', 'resultFingerprint', 'settledAt', 'reasonCode',
]);

function normalizeScope(value) {
  object(value, 'governance_scope_invalid');
  return Object.freeze({
    kind: identifier(value.kind, 'scope kind'),
    fingerprint: digestValue(value.fingerprint),
  });
}

function scalarAttributes(value = {}) {
  object(value, 'governance_attributes_invalid');
  const entries = Object.entries(value);
  if (entries.length > 32) throw new ContractError('governance_attributes_invalid', 'governance attributes exceed 32 fields');
  const result = {};
  for (const [key, item] of entries) {
    identifier(key, 'attribute name');
    if (!['string', 'number', 'boolean'].includes(typeof item) && item !== null) {
      throw new ContractError('governance_attributes_invalid', 'governance attributes must be scalar');
    }
    result[key] = typeof item === 'string' ? bounded(item, 512, 'attribute value') : item;
  }
  return Object.freeze(result);
}

function references(value = []) {
  if (!Array.isArray(value) || value.length > 64) {
    throw new ContractError('governance_references_invalid', 'governance references must be an array of at most 64 values');
  }
  return Object.freeze([...new Set(value.map((item) => reference(item, 'evidence reference')))]);
}

function reference(value, label) {
  return bounded(value, 512, label);
}

function identifier(value, label) {
  const text = bounded(value, 160, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/u.test(text)) {
    throw new ContractError('governance_identifier_invalid', `${label} has an invalid format`);
  }
  return text;
}

function bounded(value, maximum, label) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maximum) {
    throw new ContractError('governance_value_invalid', `${label} must be bounded non-empty text`);
  }
  return value;
}

function digestValue(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ContractError('governance_fingerprint_invalid', 'governance fingerprints require source material');
  }
  return /^[a-f0-9]{64}$/u.test(value) ? value : governanceFingerprint(value);
}

function member(value, values, label) {
  if (!values.has(value)) throw new ContractError('governance_enum_invalid', `${label} is invalid`);
  return value;
}

function timestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new ContractError('governance_timestamp_invalid', `${label} is invalid`);
  return value;
}

function nullableTimestamp(value) {
  return value === undefined || value === null ? null : timestamp(value, 'validity timestamp');
}

function object(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContractError(code, 'governance record must be an object');
}

function exactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ContractError('governance_fields_invalid', `${label} contains unsupported fields: ${unknown.join(', ')}`);
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
