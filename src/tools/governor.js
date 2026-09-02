// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { requestDigest } from '../persistence/reviewer-ledger.js';
import { MAX_SUBSCRIPTION_TIMEOUT_MS } from '../events.js';
import { redactExtensionData, redactText } from '../redaction.js';
import { normalizeToolReasonCode } from './reason-code.js';

// This outer event boundary must remain above the largest configured semantic-review
// deadline. The reviewer owns the operative timeout; this is only a stuck-handler backstop.
const REVIEW_SETTLEMENT_GRACE_MS = 5_000;
const CORRECTABLE_WORK_REJECTIONS = new Set([
  'goal_already_blocked', 'goal_already_completed', 'goal_missing', 'goal_not_terminal',
  'goal_tasks_actionable', 'goal_tasks_unfinished', 'task_active_conflict', 'task_capacity',
  'task_id_invalid', 'task_missing', 'task_status_invalid', 'work_plan_invalid',
  'work_revision_conflict', 'work_text_invalid',
]);
export const MANDATORY_REVIEW_EVENT_TIMEOUT_MS = MAX_SUBSCRIPTION_TIMEOUT_MS;

export function mandatoryReviewEventTimeout(semanticReviewMs) {
  const maximumSemanticMs = MAX_SUBSCRIPTION_TIMEOUT_MS - REVIEW_SETTLEMENT_GRACE_MS;
  if (!Number.isInteger(semanticReviewMs) || semanticReviewMs < 1 || semanticReviewMs > maximumSemanticMs) {
    throw new ContractError('invalid_review_timeout', `semantic review timeout must be an integer from 1 to ${maximumSemanticMs}`);
  }
  return semanticReviewMs + REVIEW_SETTLEMENT_GRACE_MS;
}

export class ToolGovernor {
  #pending = new Map();
  #activeDecisions = new Map();

  constructor(options) {
    this.events = options.events;
    this.reviewer = options.reviewer;
    this.registry = options.registry;
    this.governance = options.governance ?? null;
    this.permissionBroker = options.permissionBroker ?? null;
    this.events.register({
      id: 'kernel.mandatory-reviewer', category: 'permission', phase: 'pre',
      blocking: true, mandatory: true, priority: -10_000,
      timeoutMs: options.reviewTimeoutMs ?? MANDATORY_REVIEW_EVENT_TIMEOUT_MS, failurePolicy: 'deny',
      cancellation: 'propagate', origin: 'kernel:mandatory-reviewer', trust: 'kernel',
      inputContract: 'nna.permission-review/1.0', outputContract: 'nna.review-decision/1.0',
      resourceBounds: Object.freeze({ maxOutputBytes: 65_536, maxConcurrent: 1 }),
    }, (event) => this.#reviewSubscription(event));
  }

  async review(request, context, event) {
    this.#pending.set(request.id, { request, context });
    try {
      const dispatch = await this.events.dispatch(event, context.signal);
      const result = dispatch.results?.find((item) => item?.review)?.review;
      if (dispatch.decision === 'deny' && result?.outcome === 'approve') {
        await this.reviewer.ledger.executionStarted(request.id, result.id);
        await this.reviewer.ledger.settle(request.id, {
          status: 'cancelled', effect_certainty: 'none',
          result_fingerprint: 'additional_policy_denial', elapsed_ms: 0,
        });
        return Object.freeze({
          outcome: 'deny_with_guidance', reasonCode: 'additional_policy_denial',
          guidance: 'An additional policy restriction denied execution.', requestId: request.id,
        });
      }
      if (result?.outcome === 'escalate_to_operator') {
        if (context.reviewPosture === 'unattended') {
          return Object.freeze({
            outcome: 'deny_with_guidance', reasonCode: 'unattended_escalation_denied',
            guidance: 'Unattended posture cannot obtain operator approval. This exact operation is unavailable for the remainder of the turn; continue only through an independently authorized route.',
            requestId: request.id,
          });
        }
        if (!this.permissionBroker || context.surface !== 'interactive_tui') {
          return Object.freeze({
            outcome: 'deny_with_guidance', reasonCode: 'interactive_escalation_unavailable',
            guidance: 'This operation requires an authenticated interactive decision.', requestId: request.id,
          });
        }
        const operator = await this.permissionBroker.request(request, result, context, context.signal);
        const committed = await this.reviewer.ledger.commitOperatorDecision(request.id, operator);
        await this.governance?.recordAuthorization(request, committed, context);
        return committed;
      }
      if (result) return result;
      return Object.freeze({
        outcome: 'deny_with_guidance', reasonCode: 'mandatory_review_failed',
        guidance: 'Mandatory review could not be completed.', requestId: request.id,
      });
    } finally {
      this.#pending.delete(request.id);
    }
  }

  async beginExecution(request, decision, current) {
    this.#revalidate(request, decision, current);
    await this.reviewer.ledger.executionStarted(request.id, decision.id);
    this.#activeDecisions.set(request.id, decision.id);
  }

  async executePrepared(request, decision, signal) {
    const definition = this.registry.definition(request.toolName, request.definitionVersion);
    const started = performance.now();
    try {
      const raw = await executeBounded(definition, request, signal, { reviewerDecisionId: decision.id });
      const status = ['failed', 'completed_nonzero'].includes(raw.status) ? raw.status : 'succeeded';
      return normalizeResult(request, definition, status, raw.content, raw.metadata, started, definition.maxOutputBytes,
        raw.effectCertainty,
        status !== 'succeeded' ? normalizeToolReasonCode(raw.reasonCode, 'tool_reported_failure') : null);
    } catch (error) {
      return normalizeFailure(request, definition, error, started);
    }
  }

  async settle(result) {
    return this.reconcile(result.request_id, toolSettlementTerminal(result));
  }

  async reconcile(requestId, terminal) {
    const settled = await this.reviewer.ledger.settle(requestId, terminal);
    const execution = this.reviewer.ledger.execution?.(requestId);
    const decisionId = execution?.decisionId ?? this.#activeDecisions.get(requestId);
    if (decisionId && this.governance) {
      await this.governance.settleDecision(decisionId, {
        status: governanceTerminal(settled.status), effectCertainty: settled.effect_certainty,
        resultFingerprint: settled.result_fingerprint, reasonCode: settled.reason_code ?? null,
      });
    }
    this.#activeDecisions.delete(requestId);
    return settled;
  }

  #revalidate(request, decision, current) {
    if (!current?.authority) {
      throw new ContractError('tool_revalidation_drift', 'approval authority is unavailable at the execution boundary');
    }
    const exact = decision.outcome === 'approve'
      && decision.requestId === request.id
      && decision.requestDigest === requestDigest(request)
      && decision.authorityId === current.authority.id
      && decision.authorityVersion === current.authority.version
      && decision.authorityRestrictionVersion === (current.authority.restrictionVersion ?? 0)
      && decision.policyVersion === current.policyVersion
      && request.workspaceRoot === current.workspaceRoot;
    if (!exact) throw new ContractError('tool_revalidation_drift', 'approval no longer matches the exact request, authority, policy, or workspace');
    if (decision.expiresAt < Date.now()) {
      throw new ContractError('tool_revalidation_drift', 'approval expired after review but before execution');
    }
  }

  async #reviewSubscription(event) {
    const pending = this.#pending.get(event.payload.request_id);
    if (!pending) return { decision: 'deny', code: 'review_request_missing' };
    const review = await this.reviewer.review(pending.request, pending.context);
    const continuing = review.outcome === 'approve' || review.outcome === 'escalate_to_operator';
    return { decision: continuing ? 'continue' : 'deny', review };
  }
}

export function toolSettlementTerminal(result) {
  return Object.freeze({
    status: result.status, effect_certainty: result.effect_certainty,
    result_fingerprint: fingerprintResult(result), elapsed_ms: result.elapsed_ms,
    reason_code: result.reason_code ?? null,
  });
}

export function denialResult(request, decision) {
  const recovery = denialRecovery(decision);
  return Object.freeze({
    request_id: request.id, provider_call_id: request.providerCallId,
    tool_name: request.toolName, status: 'denied', review_outcome: decision.outcome,
    content: redactText(`${decision.guidance ?? decision.reasonCode}\n\n${recovery.instruction}`), truncated: false,
    elapsed_ms: 0, effect_certainty: 'none', untrusted: true,
    reason_code: decision.reasonCode, metadata: Object.freeze({
      denial_kind: recovery.kind, continuation: recovery.continuation,
      retry: recovery.retry ?? 'materially_different_only', user_clarification: recovery.userClarification,
    }),
  });
}

function denialRecovery(decision) {
  if (decision.reasonCode === 'unattended_escalation_denied') return {
    // Why: unattended execution has no live approval channel. Recommending a retry or
    // clarification would create an impossible recovery loop rather than useful progress.
    kind: 'operator_unavailable', continuation: 'continue_without_escalated_operation',
    userClarification: false, retry: 'never_this_turn',
    instruction: 'Do not retry this operation during the current turn and do not ask for interactive approval. Continue independent work through a safer already-authorized route. If the objective materially depends on this operation, preserve it as blocked evidence and report that bounded blocker.',
  };
  if (decision.outcome === 'hard_deny') return {
    kind: 'immutable_policy', continuation: 'continue_within_boundary', userClarification: false,
    instruction: 'This is an immutable policy boundary. Do not retry or imply that additional user authorization can override it. Continue all remaining work within the boundary; report it only if it blocks the objective.',
  };
  if (['mandatory_review_failed', 'semantic_review_unavailable'].includes(decision.reasonCode)) return {
    kind: 'reviewer_unavailable', continuation: 'replan_safer', userClarification: false,
    instruction: 'The reviewer was unavailable; this is not a finding that the user withheld authorization. Do not repeat the same request unchanged. Continue through a safer deterministic approach, or report reviewer unavailability only if no useful path remains.',
  };
  return {
    kind: 'review_denial', continuation: 'replan_safer', userClarification: true,
    instruction: 'Treat this denial as a constraint, not task completion. Do not repeat an equivalent request unchanged. Continue through a safer, narrower, or more reversible approach. Ask the user only if no meaningful alternative remains; then state what you tried, what was denied, and the explicit authorization or information needed.',
  };
}

export function invalidResult(call, error) {
  return Object.freeze({
    request_id: null, provider_call_id: call.providerCallId ?? null,
    tool_name: call.name ?? null, status: 'invalid_request',
    content: redactText(error instanceof ContractError ? error.message : 'invalid tool request'),
    truncated: false, elapsed_ms: 0, effect_certainty: 'none',
    untrusted: true, reason_code: normalizeToolReasonCode(error?.code, 'tool_invalid'),
  });
}

export function blockedResult(request, error) {
  return Object.freeze({
    request_id: request.id, provider_call_id: request.providerCallId,
    tool_name: request.toolName, status: 'failed',
    content: redactText(error instanceof ContractError ? error.message : 'execution-boundary revalidation failed'),
    truncated: false, elapsed_ms: 0, effect_certainty: 'none',
    untrusted: true, reason_code: normalizeToolReasonCode(error?.code, 'tool_revalidation_failed'),
    ledger_started: false,
  });
}

async function executeBounded(definition, request, parentSignal, executionContext) {
  if (parentSignal.aborted) throw new ContractError('tool_cancelled', 'tool execution was cancelled');
  const controller = new AbortController();
  let timeoutId;
  let parentAbort;
  // Invariant: a null outer deadline is valid only when the executor owns a bounded
  // operation phase and a user-cancellable native acquisition phase.
  const timeout = definition.timeoutMs === null ? null : new Promise((resolve) => {
    timeoutId = setTimeout(() => { controller.abort(); resolve({ boundary: 'timeout' }); }, definition.timeoutMs);
  });
  const cancelled = new Promise((resolve) => {
    parentAbort = () => { controller.abort(); resolve({ boundary: 'cancelled' }); };
    parentSignal.addEventListener('abort', parentAbort, { once: true });
  });
  const operation = Promise.resolve()
    .then(() => definition.executor(request, controller.signal, executionContext))
    .then((value) => ({ value }), (error) => ({ error }));
  try {
    const settled = await Promise.race([operation, cancelled, ...(timeout ? [timeout] : [])]);
    if (settled.boundary === 'timeout') throw new ContractError('tool_timeout', 'tool execution timed out');
    if (settled.boundary === 'cancelled') {
      // Sub-agent abort must close its child engine before parent settlement.
      if (definition.scope === 'subagent') await operation;
      throw new ContractError('tool_cancelled', 'tool execution was cancelled');
    }
    if (settled.error) throw settled.error;
    return settled.value;
  } finally {
    clearTimeout(timeoutId);
    parentSignal.removeEventListener('abort', parentAbort);
  }
}

function normalizeResult(request, definition, status, content, metadata, started, maxOutputBytes,
  reportedEffectCertainty = null, reasonCode = null) {
  const rawBytes = Buffer.byteLength(String(content), 'utf8');
  // Why: this is the single model-facing result boundary shared by bundled and external tools.
  // Redact before bounding so a credential cannot be split into an unrecognizable partial value.
  const source = redactText(String(content));
  const bounded = truncateUtf8(source, maxOutputBytes);
  return Object.freeze({
    request_id: request.id, provider_call_id: request.providerCallId,
    tool_name: request.toolName, status, content: bounded,
    truncated: rawBytes > maxOutputBytes || Buffer.byteLength(bounded) !== Buffer.byteLength(source),
    elapsed_ms: Math.max(0, performance.now() - started),
    effect_certainty: returnedEffectCertainty(definition, request, status, reportedEffectCertainty),
    untrusted: true, metadata: redactExtensionData(metadata), ledger_started: true,
    ...(reasonCode ? { reason_code: reasonCode } : {}),
  });
}

function returnedEffectCertainty(definition, request, status, reported) {
  if (['none', 'completed', 'unknown'].includes(reported)) return reported;
  if (status === 'succeeded') return 'completed';
  return toolRequestReadOnly(definition, request) ? 'none' : 'unknown';
}

function truncateUtf8(value, maximum) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maximum) return value;
  return bytes.subarray(0, maximum).toString('utf8').replace(/\uFFFD$/u, '');
}

function normalizeFailure(request, definition, error, started) {
  const cancelled = error.code === 'tool_cancelled';
  const timeout = error.code === 'tool_timeout';
  const invalidRequest = definition.scope === 'conversation_work'
    && error instanceof ContractError && CORRECTABLE_WORK_REJECTIONS.has(error.code);
  return Object.freeze({
    request_id: request.id, provider_call_id: request.providerCallId,
    tool_name: request.toolName,
    status: timeout ? 'timed_out' : cancelled ? 'cancelled' : invalidRequest ? 'invalid_request' : 'failed',
    content: redactText(error instanceof ContractError ? error.message : 'tool execution failed'),
    truncated: false, elapsed_ms: Math.max(0, performance.now() - started),
    effect_certainty: invalidRequest ? 'none' : effectCertainty(definition, request, error),
    untrusted: true, metadata: failureMetadata(error),
    reason_code: normalizeToolReasonCode(error?.code, 'executor_failure'), ledger_started: true,
  });
}

function failureMetadata(error) {
  const candidate = error?.toolMetadata;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
    || Object.keys(candidate).length > 16) return null;
  const entries = Object.entries(candidate);
  if (entries.some(([key, value]) => !/^[a-z][a-z0-9_]{0,63}$/u.test(key)
    || !(value === null || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value))
      || (typeof value === 'string' && value.length <= 512)))) return null;
  return Object.freeze(redactExtensionData(Object.fromEntries(entries)));
}

function effectCertainty(definition, request, error) {
  if (toolRequestReadOnly(definition, request)) return 'none';
  if (error.code === 'tool_revalidation_drift') return 'none';
  return 'unknown';
}

function toolRequestReadOnly(definition, request) {
  return definition?.sideEffect === 'read_only' || request?.resolved?.readOnly === true;
}

function fingerprintResult(result) {
  return `${result.status}:${Buffer.byteLength(result.content, 'utf8')}:${result.truncated}`;
}

function governanceTerminal(status) {
  if (status === 'succeeded') return 'applied';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'unknown_effect') return 'unknown_effect';
  return 'failed';
}
