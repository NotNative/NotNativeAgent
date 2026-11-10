// SPDX-License-Identifier: Apache-2.0
import { ContractError, newId } from './ids.js';
import { requestDigest } from './persistence/reviewer-ledger.js';
import { safeReviewDefinition, safeReviewRequest } from './reviewer-packet.js';
import { EMPTY_CONVERSATION_TEXT_LANE } from './conversation-text-lane.js';
import { externalBrowserGuidance } from './reliability/external-browser.js';
import { classify, resolvedOutsideWorkspace } from './reviewer-classification.js';
import { recordAndSettleAuthorization } from './reviewer-delivery.js';
import { elapsedMs } from './timing.js';
const OUTCOMES = new Set(['approve', 'deny_with_guidance', 'hard_deny', 'escalate_to_operator']);
const REVIEWER_SERVICE_FAILURES = new Set([
  'mandatory_review_failed', 'turn_cancelled', 'provider_reasoning_control_rejected', 'semantic_review_unavailable', 'semantic_review_timeout',
  'authority_anchor_missing', 'authority_anchor_invalid', 'process_effect_unclassified',
]);
export class MandatoryReviewer {
  constructor(options) {
    this.ledger = options.ledger;
    this.governance = options.governance ?? null;
    this.telemetry = options.telemetry;
    this.semantic = options.semanticReviewer ?? new UnavailableSemanticReviewer();
    this.semanticTimeoutMs = options.semanticTimeoutMs ?? 15_000;
    this.decisionTtlMs = options.decisionTtlMs ?? 120_000;
  }
  health() {
    return Object.freeze({
      mandatory: true, semantic_component: this.semantic.constructor.name,
      semantic_status: this.semantic instanceof UnavailableSemanticReviewer ? 'unavailable' : 'configured',
      semantic_timeout_ms: this.semanticTimeoutMs,
    });
  }
  async review(request, context) {
    const classification = classify(request, context.definition);
    const correlation = {
      spanId: `review:${request.id}`, turnId: context.turnId, stepId: context.stepId,
      toolRequestId: request.id, parentSpanId: context.stepId,
    };
    const started = process.hrtime.bigint();
    this.telemetry?.record('review.decision', 'started', {
      request, classification, authenticated_intent: context.authority?.intent,
      mission: context.authority?.mission, review_posture: context.reviewPosture,
    }, correlation);
    try {
      const entry = await this.ledger.propose(request, classification,
        { turnId: context.turnId, operatorRequestId: context.operatorRequestId });
      let decision;
      const missionViolation = missionBoundaryViolation(request, context.definition, context.authority?.mission);
      const intentRelation = authenticatedIntentRelation(request, context.authority, context.definition);
      if (missionViolation) decision = hardDeny(missionViolation, request);
      else if (request.toolName === 'shell_run' && request.args?.privilege === 'administrator'
        && context.reviewPosture === 'unattended') decision = deny('unattended_escalation_denied', 'Administrator execution requires a present user for native authentication.', request);
      else if (context.authority?.complete === false && !context.authority?.mission && classification.risk !== 'safe') {
        decision = deny(
          'authority_history_incomplete',
          'This resumed session cannot reconstruct all prior authority. Clear the conversation or start a new one, then restate the request.',
          request,
        );
      }
      else if (request.resolved?.reliabilitySignals?.includes('external_browser')) decision = deny('external_browser_tool_required', externalBrowserGuidance(context.surface), request);
      else if (classification.risk === 'safe') decision = approve('deterministic_safe', request);
      else if (classification.risk === 'reversible' && intentRelation === 'covered') {
        decision = approve('deterministic_reversible', request);
      }
      else if (classification.risk === 'prohibited') decision = hardDeny(classification.reason, request);
      else decision = await this.#semanticDecision(request, context, entry, intentRelation);
      const administrator = request.toolName === 'shell_run' && request.args.privilege === 'administrator';
      if ((context.definition.name === 'system_elevate' || administrator) && decision.outcome === 'escalate_to_operator') {
        decision = deny(
          'elevation_review_uncertain',
          'The reviewer did not approve this elevated operation. Revise the operation or ask the operator for clearer intent.',
          request,
        );
      }
      if (context.reviewPosture === 'prompt' && decision.outcome === 'approve'
        && !administrator && !['system_elevate', 'turn_finish', 'question'].includes(context.definition.name)) {
        decision = escalate('prompt_posture_operator_decision', request, 'Prompt posture requires operator approval before execution.');
      }
      if (decision.outcome === 'approve') decision = refreshApprovalWindow(decision, this.decisionTtlMs);
      const committed = await this.ledger.commitDecision(request.id, decision);
      await recordAndSettleAuthorization(this, request, committed, { ...context, classification });
      recordReviewDecision(this, committed, classification, entry.repetition, correlation, started);
      return committed;
    } catch (error) {
      this.telemetry?.record('review.decision', 'failed', {
        classification, failure: { code: error?.code ?? 'review_failed', name: error?.name ?? 'Error' },
      }, { ...correlation, durationMs: elapsedMs(started), reasonCode: error?.code });
      throw error;
    }
  }
  async #semanticDecision(request, context, entry, intentRelation) {
    const prior = this.ledger.summary(request).slice(0, -1);
    // Why: availability failures fail closed for that request but do not establish a policy denial.
    if (entry.repetition >= 1 && prior.some((item) => item.decision === 'deny_with_guidance'
      && !REVIEWER_SERVICE_FAILURES.has(item.reasonCode))) {
      return deny(
        'repeated_denied_operation',
        'An equivalent operation was already denied. Choose a materially different or safer approach.',
        request,
      );
    }
    const input = Object.freeze({
      request: safeReviewRequest(request, resolvedOutsideWorkspace(request)), classification: classify(request, context.definition),
      toolDefinition: safeReviewDefinition(context.definition),
      authenticatedIntent: context.authority.intent,
      conversationIntent: context.conversationIntent ?? [],
      mission: context.authority.mission, justification: context.justification ?? '',
      justificationTrust: 'untrusted_model', causalEvidence: context.causalEvidence ?? [],
      conversationTextLane: context.conversationTextLane ?? EMPTY_CONVERSATION_TEXT_LANE,
      intentRelation, ledgerSummary: this.ledger.summary(request),
    });
    const candidate = await boundedReview(this.semantic, input, this.semanticTimeoutMs, context.signal, {
      turnId: context.turnId, stepId: context.stepId, toolRequestId: request.id,
      parentSpanId: context.stepId,
    });
    return normalizeCandidate(candidate, request, { ...context, semanticTimeoutMs: this.semanticTimeoutMs });
  }
}
function refreshApprovalWindow(decision, ttlMs) {
  const committedAt = Date.now();
  return Object.freeze({ ...decision, committedAt, expiresAt: committedAt + ttlMs });
}
function reviewTelemetryStatus(decision) {
  if (decision.reasonCode === 'semantic_review_timeout') return 'timed_out';
  return decision.outcome === 'approve' ? 'succeeded' : decision.outcome === 'escalate_to_operator' ? 'skipped' : 'denied';
}
function recordReviewDecision(reviewer, decision, classification, repetition, correlation, started) {
  reviewer.telemetry?.record('review.decision', reviewTelemetryStatus(decision), {
    classification, decision, ledger_repetition: repetition,
    timeout_ms: decision.reasonCode === 'semantic_review_timeout' ? reviewer.semanticTimeoutMs : undefined,
  }, { ...correlation, durationMs: elapsedMs(started), outcome: decision.outcome, reasonCode: decision.reasonCode });
}
export class UnavailableSemanticReviewer {
  async review() {
    throw new ContractError('semantic_reviewer_unavailable', 'semantic reviewer is unavailable');
  }
}

async function boundedReview(component, input, timeoutMs, externalSignal, correlation) {
  const controller = new AbortController();
  let timer; let cancel;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      // Invariant: settling the deadline first prevents the provider's abort rejection from erasing its cause.
      resolve({ failureCode: 'semantic_review_timeout' });
      controller.abort();
    }, timeoutMs);
  });
  const cancellation = new Promise((resolve, reject) => {
    cancel = () => {
      controller.abort();
      reject(new ContractError('turn_cancelled', 'turn was cancelled'));
    };
    if (externalSignal?.aborted) cancel();
    else externalSignal?.addEventListener('abort', cancel, { once: true });
  });
  try {
    const operation = Promise.resolve().then(() => component.review(input, controller.signal, correlation))
      .catch((error) => semanticFailureCandidate(error));
    return await Promise.race([operation, timeout, cancellation]);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', cancel);
  }
}

function normalizeCandidate(value, request, context) {
  if (value?.failureCode === 'semantic_review_timeout') {
    return deny(value.failureCode,
      `The reviewer exceeded its ${context.semanticTimeoutMs} ms deadline; NNA denied this operation fail-closed. `
        + 'Check the Reviewer route and its latency. Additional user permission cannot repair reviewer availability.', request);
  }
  if (value?.failureCode === 'provider_reasoning_control_rejected') {
    return deny(
      value.failureCode,
      'The reviewer provider rejected its configured reasoning controls. Test or update the Reviewer route in /providers.',
      request,
    );
  }
  if (!validSemanticDecision(value)) {
    return deny(
      'semantic_review_unavailable',
      'The semantic reviewer could not complete its check, so NNA denied this operation fail-closed. '
        + 'This is a reviewer availability or compatibility failure, not a finding that the user withheld authorization.',
      request,
    );
  }
  if (value.confidence < 0.7) {
    return deny('semantic_confidence_low', 'Reviewer confidence was insufficient.', request);
  }
  if (value.outcome === 'approve' && ['shell_run', 'process_run'].includes(request.toolName)) {
    if (value.effect_assessment === 'unknown') {
      return deny('process_effect_unknown',
        'The reviewer could not establish the effects of this command. Split it into simpler explicit operations and retry only the reviewable steps.', request);
    }
    if (!['read_only', 'state_changing'].includes(value.effect_assessment)) {
      return deny('process_effect_unclassified',
        'The reviewer omitted the process effect assessment after clarification. NNA denied the operation because the reviewer output was incomplete. Check or change the Reviewer route.', request);
    }
  }
  if (value.outcome === 'approve') return semanticApproval(value, request, context);
  if (value.outcome === 'hard_deny') return hardDeny(value.reason_code ?? 'semantic_hard_deny', request);
  if (value.outcome === 'escalate_to_operator' && context.surface !== 'interactive_tui') {
    return deny('headless_escalation_forbidden', 'Noninteractive review cannot escalate for permission.', request);
  }
  if (value.outcome === 'escalate_to_operator') {
    return decision('escalate_to_operator', value.reason_code ?? 'operator_decision_required', request, value.guidance ?? null);
  }
  return deny(value.reason_code ?? 'semantic_denial', value.guidance ?? 'Operation was not authorized.', request);
}

// Security: model-authored conversation text may explain what an operator assent refers
// to, but it can never itself grant approval. Every semantic approval cites authenticated
// intent records; an active mission envelope is the structured alternative basis. Citation
// defects are reviewer output faults, so they fail closed for the request without latching
// a substantive denial against the operation.
function semanticApproval(candidate, request, context) {
  const cited = candidate.authority_anchors;
  if (cited === undefined || cited.length === 0) {
    if (context.authority?.mission) {
      return approve('semantic_intent_match', request, {
        authorityAnchors: Object.freeze([]), effectAssessment: candidate.effect_assessment,
      });
    }
    return deny(
      'authority_anchor_missing',
      'The reviewer approved without citing an authenticated operator record. Conversation text '
        + 'explains the request, but only authenticated intent authorizes it. Restate the '
        + 'authorization as an operator message, then retry once.',
      request,
    );
  }
  const known = new Set((context.authority?.intent ?? []).map((item) => item?.sequence));
  const unique = [...new Set(cited)];
  if (!unique.every((anchor) => known.has(anchor))) {
    return deny(
      'authority_anchor_invalid',
      'The reviewer cited an authenticated intent sequence that does not exist. The reviewer '
        + 'must cite sequences present in the authenticated intent record. Retry once.',
      request,
    );
  }
  return approve('semantic_intent_match', request, {
    authorityAnchors: Object.freeze(unique), effectAssessment: candidate.effect_assessment,
  });
}

function semanticFailureCandidate(error) {
  return error?.code === 'provider_reasoning_control_rejected'
    ? Object.freeze({ failureCode: error.code }) : null;
}

function validSemanticDecision(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['outcome', 'confidence', 'reason_code', 'guidance', 'authority_anchors', 'effect_assessment'].includes(key))) return false;
  if (!OUTCOMES.has(value.outcome) || !Number.isFinite(value.confidence)
    || value.confidence < 0 || value.confidence > 1) return false;
  if (typeof value.reason_code !== 'string' || !/^[a-z0-9_.-]{1,128}$/u.test(value.reason_code)) return false;
  if (value.authority_anchors !== undefined && (!Array.isArray(value.authority_anchors)
    || value.authority_anchors.length > 4
    || !value.authority_anchors.every((anchor) => Number.isSafeInteger(anchor) && anchor >= 1))) return false;
  if (value.effect_assessment !== undefined
    && !['read_only', 'state_changing', 'unknown'].includes(value.effect_assessment)) return false;
  return value.guidance === undefined
    || (typeof value.guidance === 'string' && Buffer.byteLength(value.guidance, 'utf8') <= 4096);
}

function approve(reasonCode, request, facts = null) {
  return decision('approve', reasonCode, request, null, facts);
}

function hardDeny(reasonCode, request) {
  return decision('hard_deny', reasonCode, request, null);
}

function deny(reasonCode, guidance, request) {
  return decision('deny_with_guidance', reasonCode, request, guidance);
}

function escalate(reasonCode, request, guidance) {
  return decision('escalate_to_operator', reasonCode, request, guidance);
}

function decision(outcome, reasonCode, request, guidance, facts = null) {
  const anchors = facts?.authorityAnchors;
  return Object.freeze({
    id: newId('decision'), outcome, reasonCode, guidance,
    requestId: request.id, requestDigest: requestDigest(request),
    authorityId: request.authorityId, authorityVersion: request.authorityVersion,
    authorityRestrictionVersion: request.authorityRestrictionVersion ?? 0, policyVersion: request.policyVersion,
    committedAt: Date.now(), expiresAt: Math.min(request.expiresAt, Date.now() + 60_000),
    ...(Array.isArray(anchors) ? { authorityAnchors: anchors } : {}),
    ...(outcome === 'approve' && ['read_only', 'state_changing'].includes(facts?.effectAssessment)
      ? { effectAssessment: facts.effectAssessment } : {}),
  });
}

function authenticatedIntentRelation(request, authority, definition) {
  // Security: only semantic review interprets authenticated authority for a scope transition.
  if (request.toolName === 'workspace_change') return 'uncertain';
  if (request.toolName === 'fs_directory' && request.args?.action === 'list') return 'covered';
  if (definition.sideEffect === 'read_only') return 'covered';
  // Why a page open is not covered: the tool declares an unknown effect because a
  // page can carry data outward, so the authenticated intent must speak to it.
  // Why: free-form authenticated language is authoritative evidence, but its
  // meaning is not a mechanical fact. Structured mission ceilings are checked
  // before this point; all other consequential intent reaches semantic review.
  return authority?.mission ? 'covered' : 'uncertain';
}

function missionBoundaryViolation(request, definition, mission) {
  if (!mission) return null;
  if (!(mission.resources ?? []).includes(effectiveScope(request, definition))) return 'mission_resource_denied';
  if (!(mission.sideEffects ?? []).includes(effectiveSideEffect(request, definition))) return 'mission_side_effect_denied';
  if (!resolvedTargets(request).every((resolved) => (mission.targets ?? [])
    .some((target) => missionTargetMatches(target, request, definition, resolved)))) {
    return 'mission_target_denied';
  }
  const refs = definition.credentialRefs ?? [];
  if (refs.some((reference) => !(mission.credentialRefs ?? []).includes(reference))) return 'mission_credential_denied';
  return null;
}

function effectiveSideEffect(request, definition) {
  if (processRequest(request) && request.resolved?.readOnly === true) return 'read_only';
  if (definition.name === 'fs_directory' && request.args?.action === 'list') return 'read_only';
  return definition.name === 'fs_directory' && request.args?.action === 'remove' ? 'irreversible' : definition.sideEffect;
}
function effectiveScope(request, definition) {
  // Security: a process can address host paths independently of its working directory.
  return processRequest(request) ? 'host' : definition.scope;
}
function missionTargetMatches(rule, request, definition, resolved = null) {
  if (rule === '*' || rule === `tool:${request.toolName}` || rule === `scope:${effectiveScope(request, definition)}`) return true;
  // Security: a path-specific mission target cannot be proven from process cwd.
  if (processRequest(request)) return false;
  const target = (resolved ?? String(request.resolved?.path ?? request.resolved?.source ?? '')).replaceAll('\\', '/').toLowerCase();
  const normalized = rule.replaceAll('\\', '/').toLowerCase();
  if (normalized.endsWith('/**')) {
    const prefix = normalized.slice(0, -3).replace(/\/$/u, '');
    return target === prefix || target.startsWith(`${prefix}/`);
  }
  return target === normalized;
}
function processRequest(request) {
  return ['shell_run', 'process_run'].includes(request.toolName);
}
function resolvedTargets(request) {
  const values = [request.resolved?.path, request.resolved?.source?.path, request.resolved?.destination?.path]
    .filter((value) => typeof value === 'string');
  if (values.length > 0) return values.map((value) => value.replaceAll('\\', '/').toLowerCase());
  return [String(request.resolved?.source ?? 'external').toLowerCase()];
}
