// SPDX-License-Identifier: Apache-2.0
import { toProviderMessages } from '../context.js';
import { ToolCallAssembler } from '../reliability/tool-call-assembler.js';
import { toolCatalogContext } from '../tools/catalog-context.js';
import { routeReasoningFields } from '../provider/reasoning.js';
import { ContractError } from '../ids.js';
import { capabilitySelectionQuery } from '../tools/capability-continuity.js';
import { deduplicateToolCallBatch } from '../reliability/tool-call-deduplication.js';
import { attachProviderRequestMetadata } from '../provider/request-metadata.js';

export function providerRequest(engine, route, context, options = {}) {
  validateProviderRequestInputs(engine, route, context);
  // Preserve the bounded authenticated task projection for provider-surface
  // compatibility and audit correlation. ToolRegistry does not use its wording
  // to select schemas; the foundational surface is deterministic.
  const query = capabilitySelectionQuery(context, options.conversationIntent, options.approvedProposal);
  const messages = toProviderMessages(context, { ...route, reasoningMode: options.reasoningMode });
  const dialect = engine.reliability?.instructions(route);
  const surfacePhase = options.capabilityPhase;
  const surface = typeof engine.tools.providerSurface === 'function'
    ? engine.tools.providerSurface(query, { phase: surfacePhase })
    : { definitions: engine.tools.providerDefinitions(query, { phase: surfacePhase }), receipt: null };
  const tools = surface.definitions;
  if (options.active) options.active.providerToolSurface = surface.receipt;
  const catalog = toolCatalogContext(engine.tools.catalogSnapshot?.() ?? engine.tools.snapshot?.() ?? [], tools);
  const system = [dialect, catalog].filter(Boolean).map((content) => ({ role: 'system', content }));
  const ordered = insertGeneratedSystemMessages(messages, system);
  const accountingSections = providerAccountingSections(ordered.messages, context, ordered.injectedMessageIndexes);
  const flattenedMessages = flattenLeadingSystemMessages(ordered.messages);
  const reasoning = routeReasoningFields(route);
  // The assembled request is a boundary value. Provider adapters must not mutate shared turn state through it.
  const request = Object.freeze({
    model: route.model, messages: flattenedMessages,
    tools, temperature: route.temperature, parallelToolCalls: false,
    maxOutputTokens: boundedOutputTokens(route.maxOutputTokens, options.outputReserveTokens),
    ...(reasoning.reasoningEffort === undefined ? {} : { reasoningEffort: reasoning.reasoningEffort }),
    ...(reasoning.enableThinking === undefined ? {} : { enableThinking: reasoning.enableThinking }),
    ...(options.reasoningMode ? { reasoningMode: options.reasoningMode } : {}),
  });
  return attachProviderRequestMetadata(request, { injectedMessageIndexes: [], accountingSections });
}

function insertGeneratedSystemMessages(messages, generated) {
  if (generated.length === 0) return { messages, injectedMessageIndexes: [] };
  let index = 0;
  while (messages[index]?.role === 'system') index += 1;
  return {
    messages: [...messages.slice(0, index), ...generated, ...messages.slice(index)],
    injectedMessageIndexes: generated.map((_, offset) => index + offset),
  };
}

function flattenLeadingSystemMessages(messages) {
  let index = 0;
  while (messages[index]?.role === 'system') index += 1;
  if (index <= 1) return messages;
  return [{
    role: 'system',
    content: messages.slice(0, index).map((item) => item.content).filter(Boolean).join('\n\n'),
  }, ...messages.slice(index)];
}

function providerAccountingSections(messages, context, injectedIndexes) {
  const injected = new Set(injectedIndexes);
  let contextIndex = 0;
  return messages.map((message, index) => {
    if (injected.has(index)) return { id: 'request.injected_system', message };
    const provenance = context[contextIndex]?.provenance;
    contextIndex += 1;
    return { id: `context.${sectionLabel(provenance)}`, message };
  });
}

function sectionLabel(value) {
  const label = typeof value === 'string' ? value : 'unattributed';
  return label.split(':', 1)[0].replace(/[^a-z0-9_.-]/giu, '_').slice(0, 64) || 'unattributed';
}

function boundedOutputTokens(routeLimit, reserveLimit) {
  const values = [routeLimit, reserveLimit].filter((value) => Number.isSafeInteger(value) && value > 0);
  return values.length > 0 ? Math.min(...values) : null;
}

function validateProviderRequestInputs(engine, route, context) {
  if (!engine?.tools || (typeof engine.tools.providerSurface !== 'function'
    && typeof engine.tools.providerDefinitions !== 'function')) {
    throw new ContractError('provider_request_invalid', 'provider request requires a tool registry');
  }
  if (!route || typeof route.model !== 'string' || route.model.length === 0
    || (route.temperature != null && !Number.isFinite(route.temperature))
    || (route.maxOutputTokens != null && !Number.isInteger(route.maxOutputTokens))) {
    throw new ContractError('provider_request_invalid', 'provider request requires a valid model route');
  }
  if (!Array.isArray(context)) {
    throw new ContractError('provider_request_invalid', 'provider request context must be an array');
  }
}

export function toolContext(engine, active) {
  return {
    policyVersion: engine.config.version, authority: active.authority,
    sessionId: engine.sessionId, turnId: active.turnId, stepId: active.stepId,
    caller: 'primary', surface: engine.surface,
    reviewPosture: engine.reviewPosture,
    stateRevision: active.observableStateRevision ?? 0,
  };
}

export function executionContext(engine, active) {
  return {
    policyVersion: engine.config.version, authority: active.authority,
    workspaceRoot: engine.tools.paths.root,
  };
}

export function prepareTrustedToolHandoff(engine, items) {
  const handoff = engine.reliability.trustedToolHandoff(items);
  if (handoff) engine.tools.grantWorkflowLease(handoff.workflowLeaseTools);
  return handoff;
}

export function resetStep(active) {
  // `active` is the single engine-owned mutable accumulator for the current turn; reset it in place
  // so lifecycle and provider callbacks retain the same authoritative identity across model steps.
  const reasoningMode = active.capabilityPhase === 'action' && active.actionRepairStepPending === true
    ? 'off' : undefined;
  if (reasoningMode === 'off') active.actionRepairStepPending = false;
  active.reasoningFallbackPending = false;
  active.stepText = '';
  active.committedStepText = null;
  active.stepReasoningBytes = 0;
  active.stepReasoningText = '';
  active.stepReasoningReplayable = false;
  active.attemptReasoningText = '';
  active.attemptReasoningReplayable = false;
  active.attemptReasoningOverflow = false;
  active.finishReason = null;
  active.providerTerminal = false;
  active.toolAssembler = active.toolAssemblerFactory?.() ?? new ToolCallAssembler();
  return reasoningMode;
}

const OBSERVABLE_MUTATIONS = new Set([
  'fs.write_text', 'fs.edit_text', 'fs.edit_lines', 'fs.directory', 'fs.create_directory',
  'fs.copy_file', 'fs.move_file', 'fs.delete_file', 'process.run', 'shell.run',
  'work.plan', 'work.goal', 'work.task_add', 'work.task_update',
]);

export function observeToolState(active, items, definitionFor = () => null) {
  if (items.some((item) => item.result?.reason_code === 'tool_arguments_truncated')) {
    // Disable optional thinking only for the immediate repair attempt. Keeping
    // it off for the remainder of a long turn makes later implementation and
    // verification steps markedly worse, while a new truncation arms one new
    // bounded repair attempt.
    active.actionRepairStepPending = true;
  }
  const succeeded = items.filter((item) => item.result?.status === 'succeeded');
  const mutated = succeeded.some((item) => {
    const name = item.result?.tool_name ?? item.request?.toolName ?? item.call?.name;
    if (name === 'fs.directory' && (item.request?.args?.action ?? item.call?.args?.action) === 'list') return false;
    return OBSERVABLE_MUTATIONS.has(name) || definitionFor(name)?.sideEffect !== 'read_only';
  });
  if (mutated) {
    active.observableStateRevision = (active.observableStateRevision ?? 0) + 1;
    active.readOnlyBatchStreak = 0;
  } else if (succeeded.length > 0 && succeeded.every((item) => {
    const name = item.result?.tool_name ?? item.request?.toolName ?? item.call?.name;
    return (name === 'fs.directory' && (item.request?.args?.action ?? item.call?.args?.action) === 'list')
      || definitionFor(name)?.sideEffect === 'read_only';
  })) {
    active.readOnlyBatchStreak = (active.readOnlyBatchStreak ?? 0) + 1;
  }
  for (const item of items) {
    if (item.result?.status !== 'succeeded' || item.result?.tool_name !== 'image.inspect') continue;
    active.visualEvidence = Object.freeze({
      verdict: item.result.metadata?.visualVerdict ?? 'uncertain',
      path: item.result.metadata?.path ?? null,
      stepId: active.stepId,
    });
  }
  return Object.freeze({ mutated, readOnlyBatchStreak: active.readOnlyBatchStreak ?? 0 });
}

export function discoveryCheckpoint(reliability, active, behavior) {
  const count = behavior?.readOnlyBatchStreak ?? 0;
  if (count === 12) {
    return reliability.behavioralCheckpoint(active, 'read_only_discovery_plateau', 'review_discovery_progress', count, {
      observable_state_revision: active.observableStateRevision ?? 0,
    });
  }
  if (count > 0 && count % 24 === 0) {
    return reliability.behavioralCheckpoint(active, 'read_only_discovery_plateau', 'compact', count, {
      observable_state_revision: active.observableStateRevision ?? 0,
    });
  }
  return null;
}

export function modelStepRequestOptions(reasoningMode, active) {
  const plannedReserve = active.contextBudget?.outputReserveTokens;
  // The context planner already bounds output against the provider limit and
  // preserves input space. Do not impose a second, smaller per-step ceiling:
  // reasoning models can consume that hidden budget before producing a tool
  // call, turning otherwise valid JSON into a deterministic truncated tail.
  const normalReserve = Number.isSafeInteger(plannedReserve) && plannedReserve > 0
    ? plannedReserve : undefined;
  const outputReserveTokens = reasoningMode === 'off'
    ? Math.min(normalReserve ?? 16_000, 16_000)
    : normalReserve;
  return {
    reasoningMode,
    outputReserveTokens,
    conversationIntent: active.conversationIntent,
    approvedProposal: active.approvedProposal,
    capabilityPhase: active.capabilityPhase,
    active,
  };
}

export function completeProviderToolCalls(active) {
  return active.toolAssembler.complete(active.finishReason, {
    usage: active.attemptUsage, outputLimitTokens: active.attemptOutputLimitTokens,
  });
}

export function observeToolContracts(engine, active, items) {
  engine.reliability.observeToolContracts?.(
    { profile: { id: active.providerResource }, model: active.modelName }, items, active.toolConstraints,
    (name) => engine.tools.definition(name)?.version ?? null,
  );
}

export function suppressPostToolReasoningReplay(active) {
  // Keep reasoning enabled and fully accounted, but do not serialize a prior
  // private chain back into the next tool continuation. OpenCode's custom
  // OpenAI-compatible model path records reasoning parts while leaving
  // interleaved reasoning replay disabled; the next call reasons freshly from
  // visible text, tool calls, and tool results.
  active.reasoningContinuations = [];
  if (active.enrichment) active.enrichment.reasoningContinuations = [];
  return true;
}

export function setInitialCapabilityPhase(active, _content) {
  // Monitoring changes only the no-progress allowance for intentionally repeated
  // observations. It never selects, adds, or removes provider tool schemas.
  active.capabilityPhase = explicitMonitoringRequest(_content) ? 'monitoring' : 'orientation';
}

function explicitMonitoringRequest(content) {
  const text = String(content ?? '').slice(0, 32_768);
  return /\b(?:keep checking|monitor|poll|repeatedly check|wait for|watch)\b/iu.test(text);
}

export function groundCapabilityPhase(active) {
  active.toolEvidenceObserved = true;
  if (active.capabilityPhase === 'orientation') active.capabilityPhase = 'action';
}

export function resetReasoningRecovery(active) {
  active.reasoningFallbackUsed = false;
  active.reasoningHeadroomRetryUsed = false;
  if (active.enrichment) delete active.enrichment.reasoningRecoveryContinuation;
}

export async function deduplicateProviderToolCalls(calls, active, persist) {
  const deduplicated = deduplicateToolCallBatch(calls);
  for (const item of deduplicated.suppressed) await persist('tool_call_deduplicated', {
    schema: 'nna.tool-call-deduplicated.v1', turnId: active.turnId, stepId: active.stepId,
    providerCallId: item.providerCallId, retainedProviderCallId: item.retainedProviderCallId,
    toolName: item.toolName, identityFingerprint: item.identityFingerprint,
  });
  return deduplicated.calls;
}
