// SPDX-License-Identifier: Apache-2.0
import { governanceFingerprint } from './governance/contracts.js';
import { LearningCandidateRegistry } from './learning-candidates.js';

const DIRECT = /\b(?:build|create|develop|design|make)\b[^\r\n]{0,240}\bskill\b/iu;
const PACKAGE = /\b(?:package|formalize|turn)\b[^\r\n]{0,160}\b(?:into|as)\b[^\r\n]{0,80}\b(?:skill|workflow)\b/iu;
const SECRET = /-----BEGIN [A-Z ]+PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]+=*|\b(?:password|passwd|api[_-]?key|token|secret)\s*[:=]/iu;

export function explicitSkillRequests(records, turnRefs) {
  const allowed = new Set(Array.isArray(turnRefs) ? turnRefs : []), found = [];
  for (const record of records ?? []) {
    if (!eligible(record, allowed)) continue;
    const request = record.content.replace(/\s+/gu, ' ').trim();
    if (Buffer.byteLength(request, 'utf8') > 1024 || SECRET.test(request)) continue;
    if (!DIRECT.test(request) && !PACKAGE.test(request)) continue;
    found.push(Object.freeze({ turnId: record.turnId, request }));
    if (found.length >= 16) break;
  }
  return Object.freeze(found);
}

export async function observeSkillRequests(options) {
  const requests = explicitSkillRequests(options.records, options.turnRefs), candidates = [];
  const registry = new LearningCandidateRegistry({
    store: options.store, governance: options.engine.governance,
    runtimeKey: options.runtimeKey, scope: options.scope, telemetry: options.engine.telemetry,
  });
  for (const request of requests) {
    if (options.signal?.aborted) throw cancelled();
    const statementFingerprint = governanceFingerprint(request.request);
    const evidence = await options.engine.governance.registerEvidence({
      id: `evidence:skill-request:${request.turnId}:${statementFingerprint.slice(0, 24)}`,
      kind: 'operator_skill_request', origin: 'operator', trust: 'authority', state: 'active',
      freshness: 'current', conflict: 'none', sourceRef: `turn:${request.turnId}`,
      sourceFingerprint: request.turnId, contentFingerprint: statementFingerprint,
      scope: options.scope, observedAt: Date.now(),
      attributes: { authority_limit: 'proposal_only', candidate_kind: 'skill.workflow_opportunity' },
    });
    candidates.push(await registry.observe(skillCandidate(request, evidence.id, statementFingerprint)));
  }
  return Object.freeze(candidates);
}

function skillCandidate(request, evidenceId, fingerprint) {
  return {
    id: `candidate-skill-${fingerprint.slice(0, 24)}`,
    kind: 'skill.workflow_opportunity', confidence: 0.7, recurrenceCount: 1,
    evidenceRefs: [evidenceId], riskClass: 'proposal_only',
    expectedBenefit: 'Evaluate an explicitly requested workflow for durable reuse without creating skill clutter.',
    successCriteria: [
      'The value gate proves a skill is better than ordinary tool use or an existing skill.',
      'An operator explicitly approves any staged build and later catalog promotion.',
      'Bounded evaluation beats the unskilled baseline without expanding authority.',
    ],
    payload: {
      request: request.request, source_turn: request.turnId, state: 'specification_only',
      required_gates: 'reuse,depth,demand,advantage,verification,prerequisites,scope,maintenance,dedup,security',
    },
  };
}

function eligible(record, allowed) {
  return record?.type === 'message' && record.role === 'user' && record.trust === 'operator'
    && allowed.has(record.turnId) && typeof record.content === 'string';
}
function cancelled() {
  return Object.assign(new Error('skill opportunity scan cancelled'), { code: 'dream_cancelled', isCancellationError: true });
}
