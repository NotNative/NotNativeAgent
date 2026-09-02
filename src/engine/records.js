// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { failureEnvelope } from '../failure-envelope.js';
import { safeToolArguments } from '../tools/presentation.js';
import { redactText } from '../redaction.js';
import { durableToolResultState, toolChildState } from '../tools/tool-result-contract.js';

const MAX_TARGET_LENGTH = 512;
const MAX_TASK_LENGTH = 180;
const MAX_EXECUTABLE_LENGTH = 128;
const MAX_ARG_COUNT = 64;
const MAX_ARG_LENGTH = 256;

export function acceptedRecord(requestId, engine, turnId) {
  return { version: '1.0', type: 'accepted', request_id: requestId, accepted: true, session_id: engine.sessionId, turn_id: turnId };
}

export function userMessage(turnId, content, extra = {}) {
  return { type: 'message', role: 'user', content, trust: 'operator', turnId, partial: false, ...extra };
}

export function assistantMessage(turnId, content, detail) {
  return {
    type: 'message', role: 'assistant', content, trust: 'model', turnId,
    stepId: detail?.stepId ?? null, partial: detail?.partial ?? false,
  };
}

export function toolRequestRecord(request, turnId, stepId = null) {
  return {
    type: 'tool_request', turnId, stepId, requestId: request.id,
    providerCallId: request.providerCallId, toolName: request.toolName, args: request.publicArgs ?? request.args,
  };
}

export function invalidRequestRecord(call, lifecycleId, turnId, stepId = null) {
  return {
    type: 'tool_request', turnId, stepId, requestId: lifecycleId,
    providerCallId: call.providerCallId, toolName: call.name, args: call.args,
  };
}

export function toolResultRecord(item, turnId, stepId = null) {
  const result = item.result ?? {};
  const state = durableToolResultState(result);
  return {
    type: 'tool_result', turnId, stepId, requestId: result.request_id ?? item.lifecycle?.id ?? null,
    providerCallId: result.provider_call_id, toolName: result.tool_name,
    ...state, content: result.content,
    metadata: result.metadata ?? null,
    reasonCode: result.reason_code ?? null, untrusted: true,
    effectCertainty: result.effect_certainty,
    elapsedMs: result.elapsed_ms, truncated: result.truncated,
  };
}

export function terminalRecord(engine, active, outcome, text, detail, secondaryFailures = []) {
  return {
    version: '1.0', type: 'turn_result', session_id: engine.sessionId,
    turn_id: active.turnId, request_id: active.requestId, outcome,
    text, usage: active.usage, reasoning_bytes: active.reasoningBytes, partial: detail?.partial ?? false,
    token_accounting: engine.reliability?.combineTokenAccounting?.([
      active.tokenAccounting, active.delegatedTokenAccounting,
    ]) ?? active.tokenAccounting,
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
  const args = item.request?.publicArgs ?? item.request?.args ?? item.call?.args;
  const presentedArgs = args && typeof args === 'object' ? safeToolArguments(args) : null;
  const failed = !['review_pending', 'approved', 'running', 'succeeded', 'duplicate_ignored'].includes(status);
  const completedNonzero = status === 'completed_nonzero';
  const processSignalExit = item.result?.reason_code === 'process_signal_exit';
  const toolName = item.call?.name ?? item.request?.toolName ?? null;
  const agentRoute = toolName === 'agent.run' ? presentedAgentRoute(engine, presentedArgs) : null;
  return {
    version: '1.0', type: 'tool_status', session_id: engine.sessionId,
    turn_id: active.turnId, tool_request_id: item.request?.id ?? null,
    provider_call_id: item.call?.providerCallId ?? null, tool: toolName, status,
    target: boundedTarget(toolName, presentedArgs, item.request?.resolved, agentRoute),
    arguments: presentedArgs,
    agent_route: agentRoute,
    effect: item.request?.resolved?.readOnly === true ? 'read_only' : definition?.sideEffect ?? null,
    scope: definition?.scope ?? null,
    elapsed_ms: item.result?.elapsed_ms ?? null,
    effect_certainty: item.result?.effect_certainty ?? null,
    exit_code: Number.isSafeInteger(item.result?.metadata?.exitCode) ? item.result.metadata.exitCode : null,
    signal: typeof item.result?.metadata?.signal === 'string' ? item.result.metadata.signal : null,
    observation_outcome: observationOutcome(item.result?.metadata?.observation_outcome),
    diagnostic_outcome: diagnosticOutcome(item.result?.metadata?.diagnosticOutcome),
    diagnostic_visibility: diagnosticVisibility(item.result?.metadata?.diagnosticVisibility),
    reason_code: failed ? item.result?.reason_code ?? null : null,
    failure_reason: failed && !completedNonzero && !processSignalExit ? boundedFailureReason(item.result?.content) : null,
  };
}

function observationOutcome(value) {
  return ['no_matches', 'target_not_found', 'empty_directory'].includes(value) ? value : null;
}

function diagnosticOutcome(value) {
  return value === 'stderr_present' ? value : null;
}

function diagnosticVisibility(value) {
  return value === 'reduced_by_script' ? value : null;
}

function boundedTarget(tool, args, resolved = null, agentRoute = null) {
  if (!args || typeof args !== 'object') return null;
  if (tool === 'agent.run') return agentInvocation(args, agentRoute);
  if (tool === 'process.run') return processInvocation(args);
  if (tool === 'shell.run') return shellInvocation(args);
  if (tool === 'project.verify') {
    const commands = Array.isArray(resolved?.commands) ? resolved.commands.map((item) => item.display).filter(Boolean) : [];
    const invocation = sanitizedText(commands.join(' && '), MAX_TARGET_LENGTH);
    return invocation || `${args.scope ?? 'full'} verification`;
  }
  const candidate = ['path', 'file_path', 'file', 'filename', 'target']
    .find((key) => typeof args[key] === 'string' && args[key].length > 0);
  const path = candidate ? args[candidate] : '';
  const selector = tool === 'fs.search_text' ? args.query : ['fs.list', 'fs.glob'].includes(tool) ? args.pattern : null;
  if (typeof selector === 'string') return `${path || '.'} :: ${JSON.stringify(selector)}`.slice(0, MAX_TARGET_LENGTH);
  return path ? `${candidate === 'path' ? '' : `${candidate}=`}${path}`.slice(0, MAX_TARGET_LENGTH) : null;
}

function agentInvocation(args, route) {
  const type = typeof args.type === 'string' ? args.type : 'general';
  const task = typeof args.task === 'string'
    ? sanitizedText(args.task, MAX_TASK_LENGTH)
    : 'delegated task';
  const model = route?.model ? ` · ${route.model}` : '';
  const inherited = route?.inherited ? ' · inherits Primary' : '';
  return `${type}${model}${inherited}: ${task}`.slice(0, MAX_TARGET_LENGTH);
}

function presentedAgentRoute(engine, args) {
  try {
    const route = engine.router?.resolve('subagent');
    if (!route) return null;
    return Object.freeze({
      provider_profile: route.profile?.id ?? null,
      model: route.model ?? null,
      inherited: engine.config?.routes?.subagent?.assigned === false,
      agent_type: typeof args?.type === 'string' ? args.type : 'general',
    });
  } catch {
    return null;
  }
}

function shellInvocation(args) {
  if (typeof args.script !== 'string' || args.script.length === 0) return null;
  const shell = typeof args.shell === 'string' ? args.shell : 'auto';
  const script = sanitizedText(args.script);
  return `${shell}: ${script}`.slice(0, MAX_TARGET_LENGTH);
}

function processInvocation(args) {
  if (typeof args.executable !== 'string' || args.executable.length === 0) return null;
  const executable = sanitizedText(args.executable, MAX_EXECUTABLE_LENGTH);
  const argv = Array.isArray(args.args)
    ? args.args.slice(0, MAX_ARG_COUNT).map((value) => sanitizedText(String(value), MAX_ARG_LENGTH))
    : [];
  return `${executable}${argv.length ? ` ${JSON.stringify(argv)}` : ''}`.slice(0, MAX_TARGET_LENGTH);
}

function boundedFailureReason(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return sanitizedText(value, MAX_TARGET_LENGTH) || null;
}

function sanitizedText(value, maximum = Number.MAX_SAFE_INTEGER) {
  return redactText(value).replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

export function toolDecisionState(outcome) {
  if (outcome === 'approve') return 'approved';
  if (outcome === 'hard_deny') return 'hard_denied';
  if (outcome === 'escalate_to_operator') return 'escalation_pending';
  return 'denied_with_guidance';
}

export function toolResultState(result) {
  return toolChildState(result);
}

export function normalizeFailure(error, partial, causeId = null) {
  return failureEnvelope(error, { operation: 'turn', partial, causeId });
}

export function failure(code, retryable, partial = false, causeId = null) {
  return failureEnvelope(new ContractError(code, code.replaceAll('_', ' '), retryable), {
    operation: 'turn', partial, causeId,
  });
}
