// SPDX-License-Identifier: Apache-2.0
import { toProviderMessages } from '../context.js';
import { ToolCallAssembler } from '../reliability/tool-call-assembler.js';
import { toolCatalogContext } from '../tools/catalog-context.js';
import { routeReasoningFields } from '../provider/reasoning.js';
import { ContractError } from '../ids.js';
import { capabilitySelectionQuery } from '../tools/capability-continuity.js';
import { deduplicateToolCallBatch } from '../reliability/tool-call-deduplication.js';
import { monitoringIntent, taskActivatedToolNames, toolOrientedIntent } from '../tools/capability-activation.js';
import { attachProviderRequestMetadata } from '../provider/request-metadata.js';

export function providerRequest(engine, route, context, options = {}) {
  validateProviderRequestInputs(engine, route, context);
  const query = capabilitySelectionQuery(context, options.conversationIntent, options.approvedProposal);
  const toolOriented = toolOrientedIntent(query);
  const webResearch = taskActivatedToolNames(query).includes('web.search');
  const providerContext = toolOriented ? context : conversationalProviderContext(context);
  const messages = toProviderMessages(providerContext, { ...route, reasoningMode: options.reasoningMode });
  const dialect = toolOriented ? engine.reliability?.instructions(route) : null;
  const surfacePhase = toolOriented ? options.capabilityPhase : 'conversation';
  const surface = typeof engine.tools.providerSurface === 'function'
    ? engine.tools.providerSurface(query, { phase: surfacePhase })
    : { definitions: engine.tools.providerDefinitions(query), receipt: null };
  const tools = surface.definitions;
  if (options.active) options.active.providerToolSurface = surface.receipt;
  const catalog = surfacePhase === 'conversation' ? null
    : toolCatalogContext(engine.tools.catalogSnapshot?.() ?? engine.tools.snapshot?.() ?? [], tools);
  const system = [dialect, catalog, webResearch ? researchExecutionPolicy() : null]
    .filter(Boolean).map((content) => ({ role: 'system', content }));
  const ordered = insertGeneratedSystemMessages(messages, system);
  const accountingSections = providerAccountingSections(ordered.messages, providerContext, ordered.injectedMessageIndexes);
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

function researchExecutionPolicy() {
  return 'Research execution policy: before the first call, choose the smallest sufficient evidence plan and act promptly. When the user gives a numeric range, start with exactly its lower bound; for "one or two," research one candidate and do not announce or verify a couple unless the first candidate fails or comparison is explicitly required. Verify only decision-critical facts. Batch independent facts for that minimal answer. An empty result, access-denied page, CAPTCHA, or bot challenge ends that source path: do not inspect, refresh, or retry it; use at most one materially different source path, then answer from available evidence with explicit uncertainty. One trustworthy source is enough for an uncontested low-stakes fact. Once the minimum answer is supported, answer in that same model step without cleanup-only calls.';
}

function conversationalProviderContext(context) {
  // Replace only the large general engine policy. Authenticated application
  // policy, hooks, memory, attachments, and other attributed evidence remain
  // available to conversational requests even though their tool surface is empty.
  const retained = context.filter((item) => item?.provenance !== 'engine_policy');
  return [{
    role: 'system', provenance: 'engine_policy', trust: 'kernel',
    content: 'You are NotNativeAgent. Answer the authenticated conversational request directly and use native private reasoning only as much as the question benefits from. Be specific and practical. For ordinary low-stakes conversation, answer in at most 250 words unless the user explicitly requests depth. For subjective recommendations, use a short private checklist of the explicit criteria, select reasonable familiar options, and answer immediately; do not exhaustively optimize or enumerate the possibility space. Do not inspect or modify the workspace, invoke tools, or claim current external facts in this conversational mode. Ask one concise clarifying question only when the missing information would materially change the answer.',
  }, ...retained];
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
  if (handoff) engine.tools.expose(handoff.expose);
  return handoff;
}

export function resetStep(active) {
  // `active` is the single engine-owned mutable accumulator for the current turn; reset it in place
  // so lifecycle and provider callbacks retain the same authoritative identity across model steps.
  const reasoningMode = undefined;
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

export function modelStepRequestOptions(reasoningMode, active) {
  const plannedReserve = active.contextBudget?.outputReserveTokens;
  // Preserve native reasoning on every call, while preventing a stochastic
  // opening step from consuming the provider's entire 32K output allowance.
  // A reasoning-only ceiling receives one reasoning-enabled checkpoint retry.
  const outputReserveTokens = Math.min(
    Number.isSafeInteger(plannedReserve) ? plannedReserve : 4_096,
    4_096,
  );
  return {
    reasoningMode,
    outputReserveTokens,
    conversationIntent: active.conversationIntent,
    approvedProposal: active.approvedProposal,
    capabilityPhase: active.capabilityPhase,
    active,
  };
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

export function setInitialCapabilityPhase(active, content) {
  active.capabilityPhase = monitoringIntent(content) ? 'monitoring' : 'orientation';
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
