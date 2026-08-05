// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { failureEnvelope } from './failure-envelope.js';
import { safeToolArguments } from './tool-presentation.js';
import { requestsInput } from './completion-supervisor.js';
import { redactText } from './redaction.js';

export function acceptedRecord(requestId, engine, turnId) {
  return { version: '1.0', type: 'accepted', request_id: requestId, accepted: true, session_id: engine.sessionId, turn_id: turnId };
}

export function userMessage(turnId, content, extra = {}) {
  return { type: 'message', role: 'user', content, trust: 'operator', turnId, partial: false, ...extra };
}

export function assistantMessage(turnId, content, detail) {
  return { type: 'message', role: 'assistant', content, trust: 'model', turnId, partial: detail?.partial ?? false };
}

export function toolRequestRecord(request, turnId) {
  return {
    type: 'tool_request', turnId, requestId: request.id,
    providerCallId: request.providerCallId, toolName: request.toolName, args: request.args,
  };
}

export function invalidRequestRecord(call, lifecycleId, turnId) {
  return {
    type: 'tool_request', turnId, requestId: lifecycleId,
    providerCallId: call.providerCallId, toolName: call.name, args: call.args,
  };
}

export function toolResultRecord(item, turnId) {
  return {
    type: 'tool_result', turnId, requestId: item.result.request_id ?? item.lifecycle.id,
    providerCallId: item.result.provider_call_id, toolName: item.result.tool_name,
    status: item.result.status, content: item.result.content,
    metadata: item.result.metadata ?? null,
    reasonCode: item.result.reason_code ?? null, untrusted: true,
    effectCertainty: item.result.effect_certainty,
    elapsedMs: item.result.elapsed_ms, truncated: item.result.truncated,
  };
}

export function terminalRecord(engine, active, outcome, text, detail, secondaryFailures = []) {
  return {
    version: '1.0', type: 'turn_result', session_id: engine.sessionId,
    turn_id: active.turnId, request_id: active.requestId, outcome,
    text, usage: active.usage, reasoning_bytes: active.reasoningBytes, partial: detail?.partial ?? false,
    retryable: detail?.retryable ?? false, failure: detail,
    secondary_failures: Object.freeze([...secondaryFailures]),
    recovery: active.recovery?.actions ?? [],
    attachment_admission: active.admission,
  };
}

export function reviewStatus(engine, active, item) {
  return {
    version: '1.0', type: 'review_status', session_id: engine.sessionId,
    turn_id: active.turnId, tool_request_id: item.request.id,
    decision_id: item.decision.id ?? null, outcome: item.decision.outcome,
    reason_code: item.decision.reasonCode,
  };
}

export function toolStatus(engine, active, item, status) {
  const definition = item.request ? engine.tools.definition(item.request.toolName, item.request.definitionVersion) : null;
  const args = item.request?.args ?? item.call.args;
  const failed = !['running', 'succeeded', 'duplicate_ignored'].includes(status);
  return {
    version: '1.0', type: 'tool_status', session_id: engine.sessionId,
    turn_id: active.turnId, tool_request_id: item.request?.id ?? null,
    provider_call_id: item.call.providerCallId, tool: item.call.name, status,
    target: boundedTarget(item.call.name, args),
    arguments: args && typeof args === 'object' ? safeToolArguments(args) : null,
    effect: definition?.sideEffect ?? null, scope: definition?.scope ?? null,
    elapsed_ms: item.result?.elapsed_ms ?? null,
    effect_certainty: item.result?.effect_certainty ?? null,
    reason_code: failed ? item.result?.reason_code ?? null : null,
    failure_reason: failed ? boundedFailureReason(item.result?.content) : null,
  };
}

function boundedTarget(tool, args) {
  if (!args || typeof args !== 'object') return null;
  const candidate = ['path', 'file_path', 'file', 'filename', 'target']
    .find((key) => typeof args[key] === 'string' && args[key].length > 0);
  const path = candidate ? args[candidate] : '';
  const selector = tool === 'fs.search_text' ? args.query : tool === 'fs.glob' ? args.pattern : null;
  if (typeof selector === 'string') return `${path || '.'} :: ${JSON.stringify(selector)}`.slice(0, 512);
  return path ? `${candidate === 'path' ? '' : `${candidate}=`}${path}`.slice(0, 512) : null;
}

function boundedFailureReason(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return redactText(value).replace(/\s+/gu, ' ').trim().slice(0, 512) || null;
}

export function toolDecisionState(outcome) {
  if (outcome === 'approve') return 'approved';
  if (outcome === 'hard_deny') return 'hard_denied';
  if (outcome === 'escalate_to_operator') return 'escalation_pending';
  return 'denied_with_guidance';
}

export function toolResultState(result) {
  if (result.status === 'succeeded') return 'succeeded';
  if (result.status === 'timed_out') return 'timed_out';
  if (result.status === 'cancelled') return 'cancelled';
  if (result.effect_certainty === 'unknown') return 'unknown_effect';
  return 'failed';
}

export function classifyCompletion(text) {
  if (text.trim().length === 0) throw new ContractError('empty_model_output', 'model produced no text', true);
  return requestsInput(text) ? 'needs_input' : 'completed';
}

export function normalizeFailure(error, partial, causeId = null) {
  return failureEnvelope(error, { operation: 'turn', partial, causeId });
}

export function failure(code, retryable, partial = false, causeId = null) {
  return failureEnvelope(new ContractError(code, code.replaceAll('_', ' '), retryable), {
    operation: 'turn', partial, causeId,
  });
}
