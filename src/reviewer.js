// SPDX-License-Identifier: Apache-2.0
import { ContractError, newId } from './ids.js';
import { requestDigest } from './persistence/reviewer-ledger.js';
import { safeReviewDefinition, safeReviewRequest } from './reviewer-packet.js';
import { EXTERNAL_BROWSER_GUIDANCE } from './reliability/external-browser.js';
import { workspaceTransitionClassification } from './reliability/workspace-scope.js';
const OUTCOMES = new Set(['approve', 'deny_with_guidance', 'hard_deny', 'escalate_to_operator']);
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
      const entry = await this.ledger.propose(request, classification);
      let decision;
      const missionViolation = missionBoundaryViolation(request, context.definition, context.authority?.mission);
      const intentRelation = authenticatedIntentRelation(request, context.authority, context.definition);
      if (missionViolation) decision = hardDeny(missionViolation, request);
      else if (context.authority?.complete === false && !context.authority?.mission && classification.risk !== 'safe') {
        decision = deny(
          'authority_history_incomplete',
          'This resumed session cannot reconstruct all prior authority. Clear the conversation or start a new one, then restate the request.',
          request,
        );
      }
      else if (request.resolved?.reliabilitySignals?.includes('external_browser')) decision = deny('external_browser_tool_required', EXTERNAL_BROWSER_GUIDANCE, request);
      else if (classification.risk === 'safe') decision = approve('deterministic_safe', request);
      else if (classification.risk === 'reversible' && intentRelation === 'covered') {
        decision = approve('deterministic_reversible', request);
      }
      else if (classification.risk === 'prohibited') decision = hardDeny(classification.reason, request);
      else decision = await this.#semanticDecision(request, context, entry, intentRelation);
      decision = requireOneShotConfirmation(decision, context.definition, request);
      if (context.reviewPosture === 'prompt' && decision.outcome === 'approve') {
        decision = escalate('prompt_posture_operator_decision', request, 'Prompt posture requires operator approval before execution.');
      }
      if (decision.outcome === 'approve') decision = refreshApprovalWindow(decision, this.decisionTtlMs);
      const committed = await this.ledger.commitDecision(request.id, decision);
      await this.governance?.recordAuthorization(request, committed, { ...context, classification });
      this.telemetry?.record('review.decision', reviewTelemetryStatus(committed.outcome), {
        classification, decision: committed, ledger_repetition: entry.repetition,
      }, { ...correlation, durationMs: elapsedMs(started), outcome: committed.outcome, reasonCode: committed.reasonCode });
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
    if (entry.repetition >= 1 && prior.some((item) => item.decision === 'deny_with_guidance')) {
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
      approvedProposal: context.approvedProposal ?? '',
      mission: context.authority.mission, justification: context.justification ?? '',
      justificationTrust: 'untrusted_model', causalEvidence: context.causalEvidence ?? [],
      intentRelation, ledgerSummary: this.ledger.summary(request),
    });
    const candidate = await boundedReview(this.semantic, input, this.semanticTimeoutMs, context.signal, {
      turnId: context.turnId, stepId: context.stepId, toolRequestId: request.id,
      parentSpanId: context.stepId,
    });
    return normalizeCandidate(candidate, request, context.surface);
  }
}
function refreshApprovalWindow(decision, ttlMs) {
  const committedAt = Date.now();
  return Object.freeze({ ...decision, committedAt, expiresAt: committedAt + ttlMs });
}
function reviewTelemetryStatus(outcome) { return outcome === 'approve' ? 'succeeded' : outcome === 'escalate_to_operator' ? 'skipped' : 'denied'; }
function elapsedMs(started) { return Number(process.hrtime.bigint() - started) / 1_000_000; }
export class UnavailableSemanticReviewer {
  async review() {
    throw new ContractError('semantic_reviewer_unavailable', 'semantic reviewer is unavailable');
  }
}
function classify(request, definition) {
  if (!definition || request.toolName !== definition.name) return definitionMismatchClassification();
  if (definition.name === 'workspace.change') return workspaceTransitionClassification(resolvedOutsideWorkspace(request));
  if (definition.name === 'fs.directory' && request.args?.action === 'list') {
    return Object.freeze({
      risk: 'safe', reason: resolvedOutsideWorkspace(request) ? 'host_read' : 'workspace_read',
      effect: 'read_only', scope: resolvedOutsideWorkspace(request) ? 'host' : 'workspace', complexity: 'simple',
    });
  }
  if (definition.sideEffect === 'read_only' && definition.scope === 'workspace') {
    return Object.freeze({
      risk: 'safe', reason: resolvedOutsideWorkspace(request) ? 'host_read' : 'workspace_read',
      effect: 'read_only', scope: resolvedOutsideWorkspace(request) ? 'host' : 'workspace', complexity: 'simple',
    });
  }
  if (definition.sideEffect === 'read_only' && definition.scope === 'product_guidance'
    && ['nna.search_guidance', 'nna.read_guidance'].includes(definition.name)) {
    return Object.freeze({ risk: 'safe', reason: 'packaged_product_guidance', effect: 'read_only', scope: 'product_guidance', complexity: 'simple' });
  }
  if (definition.sideEffect === 'read_only' && definition.scope === 'runtime_diagnostics'
    && ['nna.list_sessions', 'nna.diagnose_turn'].includes(definition.name)) {
    return Object.freeze({ risk: 'safe', reason: 'redacted_runtime_diagnostics', effect: 'read_only', scope: 'runtime_diagnostics', complexity: 'simple' });
  }
  if (definition.sideEffect === 'read_only' && definition.scope === 'runtime_info' && definition.name === 'system.time') return Object.freeze({ risk: 'safe', reason: 'host_clock_observation', effect: 'read_only', scope: 'runtime_info', complexity: 'simple' });
  if (definition.sideEffect === 'read_only' && definition.scope === 'mcp_control'
    && ['nna.mcp_status', 'nna.mcp_test'].includes(definition.name)) {
    return Object.freeze({ risk: 'safe', reason: 'configured_mcp_inspection', effect: 'read_only', scope: 'mcp_control', complexity: 'simple' });
  }
  if (definition.sideEffect === 'read_only' && definition.scope === 'web_search' && definition.name === 'web.search') {
    return Object.freeze({ risk: 'safe', reason: 'configured_web_search', effect: 'read_only', scope: 'web_search', complexity: 'simple' });
  }
  if (definition.sideEffect === 'read_only' && definition.name === 'web.fetch'
    && ['public_network', 'trusted_private_origin'].includes(request.resolved?.destination)) {
    const privateOrigin = request.resolved.destination === 'trusted_private_origin';
    return Object.freeze({ risk: 'safe', reason: privateOrigin ? 'trusted_private_web_fetch' : 'validated_public_web_fetch', effect: 'read_only', scope: privateOrigin ? 'private_network' : 'public_network', complexity: 'simple' });
  }
  if (definition.name === 'web.browse') return browserClassification(request);
  if (definition.sideEffect === 'read_only' && definition.scope === 'tool_catalog' && definition.name === 'tool.search') {
    return Object.freeze({ risk: 'safe', reason: 'bounded_tool_catalog', effect: 'read_only', scope: 'tool_catalog', complexity: 'simple' });
  }
  if (definition.scope === 'ephemeral_reference' && definition.name.startsWith('ref.')) return ephemeralReferenceClassification(definition);
  if (definition.scope === 'conversation_work' && definition.name.startsWith('work.')) {
    return Object.freeze({ risk: 'safe', reason: 'bounded_conversation_work', effect: definition.sideEffect, scope: 'conversation_work', complexity: 'simple' });
  }
  const directoryRemoval = directoryRemovalClassification(request, definition);
  if (directoryRemoval) return directoryRemoval;
  if (definition.scope === 'workspace' && ['reversible', 'irreversible'].includes(definition.sideEffect)) {
    const recovery = resolvedRecovery(request);
    if (!resolvedOutsideWorkspace(request) && ['git_tracked', 'new_target'].includes(recovery)) {
      return Object.freeze({ risk: 'reversible', reason: recovery, effect: 'reversible', scope: 'workspace', complexity: 'simple' });
    }
    return Object.freeze({
      risk: 'review_required', reason: resolvedOutsideWorkspace(request) ? 'host_mutation' : 'unverified_recovery',
      effect: definition.sideEffect, scope: resolvedOutsideWorkspace(request) ? 'host' : 'workspace', complexity: 'simple',
    });
  }
  if (definition.name === 'system.elevate') return elevationClassification();
  if (['process.run', 'shell.run'].includes(definition.name)) return processClassification(request);
  return Object.freeze({ risk: 'review_required', reason: 'uncertain_effect', effect: definition.sideEffect, scope: definition.scope, complexity: 'unknown' });
}

function processClassification(request) {
  const complexity = request.resolved.reviewComplexity ?? 'unknown';
  if (request.resolved?.readOnly === true) return Object.freeze({ risk: 'safe',
    reason: request.resolved.reviewPurpose ?? 'process_observation', effect: 'read_only',
    scope: resolvedOutsideWorkspace(request) ? 'host' : 'workspace', complexity });
  const detached = request.resolved?.reliabilitySignals?.includes('detached_process');
  const foregroundServer = request.resolved?.reliabilitySignals?.includes('long_running_foreground');
  return Object.freeze({
    risk: 'review_required',
    reason: detached ? 'detached_process_request'
      : foregroundServer ? 'long_running_foreground_request'
      : ['simple_argv', 'simple_shell'].includes(complexity) ? 'process_execution' : 'opaque_process_request',
    effect: 'unknown', scope: resolvedOutsideWorkspace(request) ? 'host' : 'workspace', complexity,
    purpose: request.resolved.reviewPurpose ?? 'general_process',
  });
}

function definitionMismatchClassification() {
  return Object.freeze({ risk: 'prohibited', reason: 'definition_mismatch', effect: 'unknown', scope: 'unknown', complexity: 'unknown' });
}

function directoryRemovalClassification(request, definition) {
  if (definition.name !== 'fs.directory' || request.args?.action !== 'remove') return null;
  return Object.freeze({
    risk: 'review_required', reason: request.args?.recursive ? 'recursive_directory_removal' : 'directory_removal',
    effect: 'irreversible', scope: resolvedOutsideWorkspace(request) ? 'host' : 'workspace', complexity: 'simple',
  });
}

function ephemeralReferenceClassification(definition) {
  return Object.freeze({ risk: 'safe', reason: 'bounded_ephemeral_reference', effect: definition.sideEffect, scope: 'ephemeral_reference', complexity: 'simple' });
}

function requireOneShotConfirmation(decision, definition, request) {
  if (definition.operatorConfirmation !== 'one_shot' || decision.outcome !== 'approve') return decision;
  return escalate(
    'elevation_operator_confirmation_required', request,
    'This exact privileged executable, argv, working directory, reason, and expected effect require a fresh local approval. Approval cannot be remembered.',
  );
}

function elevationClassification() {
  return Object.freeze({
    risk: 'review_required', reason: 'privileged_execution', effect: 'unknown', scope: 'host',
    complexity: 'privileged_execution', purpose: 'host_elevation',
  });
}

function browserClassification(request) {
  const destination = request.resolved?.destination ?? null;
  if (request.resolved?.readOnly === true && destination === 'managed_workspace_origin') return Object.freeze({ risk: 'safe', reason: 'managed_workspace_browser_navigation', effect: 'read_only', scope: 'workspace', complexity: 'simple' });
  if (request.resolved?.readOnly === true && destination === 'reviewable_loopback_origin') {
    return Object.freeze({ risk: 'review_required', reason: 'loopback_browser_navigation', effect: 'read_only', scope: 'loopback', complexity: 'simple' });
  }
  if (request.resolved?.readOnly === true && [null, 'public_network', 'trusted_private_origin'].includes(destination)) {
    return Object.freeze({ risk: 'safe', reason: 'bounded_browser_observation', effect: 'read_only', scope: destination === 'trusted_private_origin' ? 'private_network' : 'browser', complexity: 'simple' });
  }
  return Object.freeze({ risk: 'review_required', reason: 'interactive_browser_action', effect: 'unknown', scope: 'browser', complexity: 'simple' });
}

function resolvedRecovery(request) {
  if (request.toolName === 'fs.copy_file') return request.resolved?.destination?.recovery ?? 'none';
  if (request.toolName === 'fs.move_file') {
    return request.resolved?.source?.recovery === 'git_tracked' && request.resolved?.destination?.recovery === 'new_target'
      ? 'git_tracked' : 'none';
  }
  return request.resolved?.recovery ?? 'none';
}

function resolvedOutsideWorkspace(request) {
  const targets = [request.resolved, request.resolved?.source, request.resolved?.destination].filter(Boolean);
  return targets.some((target) => target.insideWorkspace === false);
}

async function boundedReview(component, input, timeoutMs, externalSignal, correlation) {
  const controller = new AbortController();
  let timer; let cancel;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs);
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
    const operation = Promise.resolve().then(() => component.review(input, controller.signal, correlation)).catch(() => null);
    return await Promise.race([operation, timeout, cancellation]);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', cancel);
  }
}

function normalizeCandidate(value, request, surface) {
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
  if (value.outcome === 'approve') return approve('semantic_intent_match', request);
  if (value.outcome === 'hard_deny') return hardDeny(value.reason_code ?? 'semantic_hard_deny', request);
  if (value.outcome === 'escalate_to_operator' && surface !== 'interactive_tui') {
    return deny('headless_escalation_forbidden', 'Noninteractive review cannot escalate for permission.', request);
  }
  if (value.outcome === 'escalate_to_operator') {
    return decision('escalate_to_operator', value.reason_code ?? 'operator_decision_required', request, value.guidance ?? null);
  }
  return deny(value.reason_code ?? 'semantic_denial', value.guidance ?? 'Operation was not authorized.', request);
}

function validSemanticDecision(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['outcome', 'confidence', 'reason_code', 'guidance'].includes(key))) return false;
  if (!OUTCOMES.has(value.outcome) || !Number.isFinite(value.confidence)
    || value.confidence < 0 || value.confidence > 1) return false;
  if (typeof value.reason_code !== 'string' || !/^[a-z0-9_.-]{1,128}$/u.test(value.reason_code)) return false;
  return value.guidance === undefined
    || (typeof value.guidance === 'string' && Buffer.byteLength(value.guidance, 'utf8') <= 4096);
}

function approve(reasonCode, request) {
  return decision('approve', reasonCode, request, null);
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

function decision(outcome, reasonCode, request, guidance) {
  return Object.freeze({
    id: newId('decision'), outcome, reasonCode, guidance,
    requestId: request.id, requestDigest: requestDigest(request),
    authorityId: request.authorityId, authorityVersion: request.authorityVersion,
    authorityRestrictionVersion: request.authorityRestrictionVersion ?? 0, policyVersion: request.policyVersion,
    committedAt: Date.now(), expiresAt: Math.min(request.expiresAt, Date.now() + 60_000),
  });
}

function authenticatedIntentRelation(request, authority, definition) {
  // Security: only semantic review interprets authenticated authority for a scope transition.
  if (request.toolName === 'workspace.change') return 'uncertain';
  if (request.toolName === 'fs.directory' && request.args?.action === 'list') return 'covered';
  if (definition.sideEffect === 'read_only') return 'covered';
  // Why: free-form authenticated language is authoritative evidence, but its
  // meaning is not a mechanical fact. Structured mission ceilings are checked
  // before this point; all other consequential intent reaches semantic review.
  return authority?.mission ? 'covered' : 'uncertain';
}

function missionBoundaryViolation(request, definition, mission) {
  if (!mission) return null;
  if (!(mission.resources ?? []).includes(definition.scope)) return 'mission_resource_denied';
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
  if (definition.name === 'fs.directory' && request.args?.action === 'list') return 'read_only';
  return definition.name === 'fs.directory' && request.args?.action === 'remove' ? 'irreversible' : definition.sideEffect;
}
function missionTargetMatches(rule, request, definition, resolved = null) {
  if (rule === '*' || rule === `tool:${request.toolName}` || rule === `scope:${definition.scope}`) return true;
  const target = (resolved ?? String(request.resolved?.path ?? request.resolved?.source ?? '')).replaceAll('\\', '/').toLowerCase();
  const normalized = rule.replaceAll('\\', '/').toLowerCase();
  if (normalized.endsWith('/**')) {
    const prefix = normalized.slice(0, -3).replace(/\/$/u, '');
    return target === prefix || target.startsWith(`${prefix}/`);
  }
  return target === normalized;
}
function resolvedTargets(request) {
  const values = [request.resolved?.path, request.resolved?.source?.path, request.resolved?.destination?.path]
    .filter((value) => typeof value === 'string');
  if (values.length > 0) return values.map((value) => value.replaceAll('\\', '/').toLowerCase());
  return [String(request.resolved?.source ?? 'external').toLowerCase()];
}
