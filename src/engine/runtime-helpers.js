// SPDX-License-Identifier: Apache-2.0
import { toProviderMessages } from '../context.js';
import { ToolCallAssembler } from '../reliability/tool-call-assembler.js';
import { toolCatalogContext } from '../tools/catalog-context.js';
import { routeReasoningFields } from '../provider/reasoning.js';
import { ContractError } from '../ids.js';
import { capabilitySelectionQuery } from '../tools/capability-continuity.js';
import { deduplicateToolCallBatch } from '../reliability/tool-call-deduplication.js';

export function providerRequest(engine, route, context, options = {}) {
  validateProviderRequestInputs(engine, route, context);
  const messages = toProviderMessages(context, { ...route, reasoningMode: options.reasoningMode });
  const dialect = engine.reliability?.instructions(route);
  const query = capabilitySelectionQuery(context, options.conversationIntent, options.approvedProposal);
  const surface = typeof engine.tools.providerSurface === 'function'
    ? engine.tools.providerSurface(query, { phase: options.capabilityPhase })
    : { definitions: engine.tools.providerDefinitions(query), receipt: null };
  const tools = surface.definitions;
  if (options.active) options.active.providerToolSurface = surface.receipt;
  const catalog = toolCatalogContext(engine.tools.catalogSnapshot?.() ?? engine.tools.snapshot?.() ?? [], tools);
  const system = [dialect, catalog].filter(Boolean).map((content) => ({ role: 'system', content }));
  const reasoning = routeReasoningFields(route);
  // The assembled request is a boundary value. Provider adapters must not mutate shared turn state through it.
  return Object.freeze({
    model: route.model, messages: [...system, ...messages],
    tools, temperature: route.temperature, parallelToolCalls: false,
    maxOutputTokens: boundedOutputTokens(route.maxOutputTokens, options.outputReserveTokens),
    ...(reasoning.reasoningEffort === undefined ? {} : { reasoningEffort: reasoning.reasoningEffort }),
    ...(reasoning.enableThinking === undefined ? {} : { enableThinking: reasoning.enableThinking }),
    ...(options.reasoningMode ? { reasoningMode: options.reasoningMode } : {}),
  });
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
  const reasoningMode = active.reasoningFallbackPending || active.capabilityPhase === 'action' ? 'off' : undefined;
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
  const outputReserveTokens = active.capabilityPhase === 'action'
    ? Math.min(Number.isSafeInteger(plannedReserve) ? plannedReserve : 8_192, 8_192)
    : plannedReserve;
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
  if (active?.capabilityPhase !== 'action' || !active.enrichment) return false;
  active.enrichment.reasoningContinuations = [];
  return true;
}

export function resetReasoningRecovery(active) {
  active.reasoningFallbackUsed = false;
  active.reasoningHeadroomRetryUsed = false;
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
