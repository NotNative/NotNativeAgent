// SPDX-License-Identifier: Apache-2.0
import { ContractError, newId } from './ids.js';
import { requestDigest } from './persistence/reviewer-ledger.js';
import { safeReviewDefinition, safeReviewRequest } from './reviewer-packet.js';

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
      const intentRelation = authenticatedIntentRelation(
        request, context.authority, context.definition, context.conversationIntent,
      );
      if (missionViolation) decision = hardDeny(missionViolation, request);
      else if (context.authority?.complete === false && !context.authority?.mission && classification.risk !== 'safe') {
        decision = deny(
          'authority_history_incomplete',
          'This resumed session cannot reconstruct all prior authority. Clear the conversation or start a new one, then restate the request.',
          request,
        );
      }
      else if (classification.risk === 'safe' && conversationOnly(context.authority)) {
        decision = deny('tool_not_justified_by_request', 'The user made a conversational request that does not require tools.', request);
      } else if (classification.risk === 'safe') decision = approve('deterministic_safe', request);
      else if (!['safe', 'prohibited'].includes(classification.risk) && intentRelation === 'conflict') {
        decision = deny(
          'authenticated_intent_mismatch',
          'The requested operation concretely conflicts with the authenticated action or target.',
          request,
        );
      }
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

function reviewTelemetryStatus(outcome) {
  return outcome === 'approve' ? 'succeeded' : outcome === 'escalate_to_operator' ? 'skipped' : 'denied';
}

function elapsedMs(started) {
  return Number(process.hrtime.bigint() - started) / 1_000_000;
}

function conversationOnly(authority) {
  const latest = authority?.intent?.at(-1)?.content;
  if (typeof latest !== 'string') return false;
  return /^\s*(?:hi|hello|hey|good\s+(?:morning|afternoon|evening)|how\s+are\s+you|thanks|thank\s+you)[!,.?\s]*$/iu.test(latest);
}

export class UnavailableSemanticReviewer {
  async review() {
    throw new ContractError('semantic_reviewer_unavailable', 'semantic reviewer is unavailable');
  }
}

function classify(request, definition) {
  if (!definition || request.toolName !== definition.name) return definitionMismatchClassification();
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
  if (['process.run', 'shell.run'].includes(definition.name)) {
    const complexity = request.resolved.reviewComplexity ?? 'unknown';
    return Object.freeze({
      risk: 'review_required',
      reason: ['simple_argv', 'simple_shell'].includes(complexity) ? 'process_execution' : 'opaque_process_request',
      effect: 'unknown', scope: resolvedOutsideWorkspace(request) ? 'host' : 'workspace', complexity,
      purpose: request.resolved.reviewPurpose ?? 'general_process',
    });
  }
  return Object.freeze({ risk: 'review_required', reason: 'uncertain_effect', effect: definition.sideEffect, scope: definition.scope, complexity: 'unknown' });
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

function authenticatedIntentRelation(request, authority, definition, conversationIntent = []) {
  if (definition.sideEffect === 'read_only') return 'covered';
  if (['process.run', 'shell.run', 'system.elevate'].includes(request.toolName)) return authorityCoversProcess(request, authority) ? 'covered' : 'uncertain';
  if (!request.toolName.startsWith('fs.')) return 'uncertain';
  const mission = authority?.mission?.outcome?.toLowerCase() ?? '';
  const targets = resolvedTargets(request);
  const action = filesystemActionPattern(request.toolName);
  if (authority?.mission) {
    const namesTargets = targets.every((target) => (authority.mission.targets ?? [])
      .some((item) => missionTargetMatches(item, request, { scope: 'workspace' }, target)));
    return namesTargets && action.test(mission) ? 'covered' : 'conflict';
  }
  if ([...(authority?.intent ?? [])].some((item) => item.kind === 'restriction'
    && broadFilesystemMutationRestriction(item.content))) return 'conflict';
  const relevant = [...(authority?.intent ?? [])].reverse().find((item) => {
    const evidence = item.content.toLowerCase();
    return targets.some((target) => evidenceNamesTarget(evidence, target));
  });
  if (relevant?.kind === 'restriction') {
    const scopedGrant = grantBeforeOtherFilesRestriction(relevant.content);
    if (scopedGrant && targets.every((target) => evidenceNamesTarget(scopedGrant, target))
      && action.test(scopedGrant)) return 'covered';
    return 'conflict';
  }
  if (taskResultArtifactCovered(request, authority, targets)) return 'covered';
  if (workspaceBuildMutationCovered(request, authority, targets, conversationIntent)) return 'covered';
  if (!relevant) return clearlyReadOnlyIntent(authority) ? 'conflict' : 'uncertain';
  const evidence = relevant.content.toLowerCase();
  if (targets.every((target) => evidenceNamesTarget(evidence, target)) && action.test(evidence)) return 'covered';
  return clearlyReadOnlyText(evidence) ? 'conflict' : 'uncertain';
}

function workspaceBuildMutationCovered(request, authority, targets, conversationIntent = []) {
  if (!['fs.directory', 'fs.create_directory', 'fs.write_text', 'fs.edit_text', 'fs.edit_lines'].includes(request.toolName)
    || (request.toolName === 'fs.directory' && request.args?.action !== 'create')
    || resolvedOutsideWorkspace(request) || targets.length !== 1) return false;
  const buildPattern = /\b(?:build|create|develop|generate|implement|make|patch|refactor|repair|scaffold|upgrade)\b/iu;
  const activeBuild = [...conversationIntent].reverse().find((item) => buildPattern.test(String(item)));
  const latest = [...(authority?.intent ?? [])].reverse().find((item) => item.kind !== 'restriction');
  if (!activeBuild && (!latest || !buildPattern.test(latest.content))) {
    return false;
  }
  return ![...(authority?.intent ?? [])].some((item) => item.kind === 'restriction'
    && broadFilesystemMutationRestriction(item.content));
}

function taskResultArtifactCovered(request, authority, targets) {
  if (request.toolName !== 'fs.write_text' || resolvedRecovery(request) !== 'new_target'
    || resolvedOutsideWorkspace(request) || targets.length !== 1) return false;
  const target = targets[0];
  const extension = /\.([a-z0-9]+)$/u.exec(target)?.[1] ?? '';
  if (!new Set(['md', 'txt', 'json', 'csv']).has(extension)) return false;
  const artifactTerms = new Set(['audit', 'autopsy', 'report', 'finding', 'analysis', 'assessment', 'review', 'summary', 'result']);
  if (![...tokenSet(target)].some((token) => artifactTerms.has(token))) return false;
  const intent = [...(authority?.intent ?? [])].reverse().find((item) => item.kind !== 'restriction'
    && /\b(?:audit|autopsy|review|analy(?:s|z)e|analysis|assess|diagnose|investigate|research)\b/iu.test(item.content));
  if (!intent) return false;
  return ![...(authority?.intent ?? [])].some((item) => item.kind === 'restriction'
    && broadFilesystemMutationRestriction(item.content));
}

function broadFilesystemMutationRestriction(value) {
  // A scoped prohibition such as "do not modify any other file" preserves the
  // explicitly named target grant; it is not a blanket revocation of all file
  // mutation authority.
  if (/\b(?:any\s+)?other\s+files?\b/iu.test(value)) return false;
  return /\b(?:write|change|replace|create|update|edit|modify|delete|remove|move|rename|copy)\b/iu.test(value)
    && /\b(?:any(?:thing)?|files?|workspace|repository|repo|codebase|reports?|artifacts?|documents?)\b/iu.test(value);
}

function grantBeforeOtherFilesRestriction(value) {
  const parts = String(value).toLowerCase().split(
    /\b(?:do\s+not|don't|never)\s+(?:write|change|replace|create|update|edit|modify|delete|remove|move|rename|copy)\s+(?:any\s+)?other\s+files?\b/iu,
  );
  return parts.length > 1 ? parts[0] : null;
}

function clearlyReadOnlyIntent(authority) {
  const latest = [...(authority?.intent ?? [])].reverse().find((item) => item.kind !== 'restriction');
  return latest ? clearlyReadOnlyText(latest.content) : false;
}

function clearlyReadOnlyText(value) {
  return /\b(?:read|inspect|audit|autopsy|review|summarize|explain|show|list|search|find|check|diagnose|answer|respond|tell)\b/iu.test(value)
    && !/\b(?:write|change|replace|create|update|edit|modify|delete|remove|move|rename|copy|fix|build|implement|install)\b/iu.test(value);
}

function authorityCoversProcess(request, authority) {
  const latest = [...(authority?.intent ?? [])].reverse().find((item) => item.kind !== 'restriction');
  if (!latest) return false;
  const evidence = tokenSet(latest.content);
  const commandText = request.toolName === 'shell.run'
    ? request.args?.script
    : [request.args?.executable, ...(request.args?.args ?? [])].join(' ');
  const command = tokenSet(commandText);
  const destructive = request.resolved?.reviewComplexity === 'destructive_shell'
    || ['rm', 'rmdir', 'del', 'erase', 'format', 'shutdown', 'reboot', 'diskpart', 'taskkill']
      .includes(String(request.args?.executable ?? '').toLowerCase());
  if (destructive && !/\b(?:delete|remove|erase|format|shutdown|reboot|kill|wipe)\b/iu.test(latest.content)) return false;
  for (const token of command) if (evidence.has(token)) return true;
  if (request.resolved?.reviewPurpose === 'network_diagnostic') {
    return /\b(?:find|locate|discover|resolve|lookup|look\s+up|ping|reach|reachable|connectivity|network|dns|host)\b/iu.test(latest.content);
  }
  return false;
}

function tokenSet(value) {
  const ignored = new Set(['run', 'exec', 'command', 'the', 'this', 'that', 'with', 'from', 'into', 'and', 'for']);
  return new Set(String(value).replace(/([a-z])([A-Z])/gu, '$1 $2').toLowerCase().split(/[^a-z0-9]+/u)
    .map((item) => item.length > 4 && item.endsWith('s') ? item.slice(0, -1) : item)
    .filter((item) => item.length > 2 && !ignored.has(item)));
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

function evidenceNamesTarget(evidence, target) {
  const normalizedEvidence = evidence.replaceAll('\\', '/');
  const segments = target.split('/').filter(Boolean);
  const name = segments.at(-1);
  const relativeSuffixes = segments.slice(1, -1)
    .map((_, index) => segments.slice(index + 1).join('/'))
    .filter((value) => value.includes('/'));
  return containsPathReference(normalizedEvidence, target)
    || relativeSuffixes.some((suffix) => containsPathReference(normalizedEvidence, suffix))
    || (name.length > 0 && containsPathReference(normalizedEvidence, name));
}

function containsPathReference(evidence, reference) {
  let offset = evidence.indexOf(reference);
  while (offset >= 0) {
    const before = offset === 0 ? '' : evidence[offset - 1];
    const afterIndex = offset + reference.length;
    const after = afterIndex >= evidence.length ? '' : evidence[afterIndex];
    if (!/[a-z0-9._/-]/u.test(before) && !/[a-z0-9._/-]/u.test(after)) return true;
    offset = evidence.indexOf(reference, offset + 1);
  }
  return false;
}

function filesystemActionPattern(toolName) {
  if (toolName === 'fs.directory') return /\b(?:create|make|add|delete|remove|clean|purge)\b/u;
  if (toolName === 'fs.delete_file') return /\b(?:delete|remove|unlink)\b/u;
  if (toolName === 'fs.copy_file') return /\b(?:copy|duplicate)\b/u;
  if (toolName === 'fs.move_file') return /\b(?:move|rename)\b/u;
  if (toolName === 'fs.create_directory') return /\b(?:create|make|add)\b/u;
  return /\b(?:write|change|replace|create|update|edit|modify)\b/u;
}
