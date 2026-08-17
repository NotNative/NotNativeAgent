// SPDX-License-Identifier: Apache-2.0
import { toProviderMessages } from '../context.js';
import { ToolCallAssembler } from '../reliability/tool-call-assembler.js';
import { toolCatalogContext } from '../tools/catalog-context.js';
import { routeReasoningFields } from '../provider/reasoning.js';
import { ContractError } from '../ids.js';

const OPERATOR_TRUST = 'operator';

export function providerRequest(engine, route, context, options = {}) {
  validateProviderRequestInputs(engine, route, context);
  const messages = toProviderMessages(context);
  const dialect = engine.reliability?.instructions(route);
  const tools = engine.tools.providerDefinitions(toolQuery(context));
  const catalog = toolCatalogContext(engine.tools.snapshot?.() ?? [], tools);
  const system = [dialect, catalog].filter(Boolean).map((content) => ({ role: 'system', content }));
  const reasoning = routeReasoningFields(route);
  // The assembled request is a boundary value. Provider adapters must not mutate shared turn state through it.
  return Object.freeze({
    model: route.model, messages: [...system, ...messages],
    tools, temperature: route.temperature,
    maxOutputTokens: route.maxOutputTokens,
    ...(reasoning.reasoningEffort === undefined ? {} : { reasoningEffort: reasoning.reasoningEffort }),
    ...(reasoning.enableThinking === undefined ? {} : { enableThinking: reasoning.enableThinking }),
    ...(options.reasoningMode ? { reasoningMode: options.reasoningMode } : {}),
  });
}

function toolQuery(context) {
  for (let index = context.length - 1; index >= 0; index -= 1) {
    const item = context[index];
    if (item && typeof item === 'object' && item.trust === OPERATOR_TRUST) return item.content ?? '';
  }
  return '';
}

function validateProviderRequestInputs(engine, route, context) {
  if (!engine?.tools || typeof engine.tools.providerDefinitions !== 'function') {
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

export function resetStep(active) {
  // `active` is the single engine-owned mutable accumulator for the current turn; reset it in place
  // so lifecycle and provider callbacks retain the same authoritative identity across model steps.
  const reasoningMode = active.reasoningFallbackPending ? 'off' : undefined;
  active.reasoningFallbackPending = false;
  active.stepText = '';
  active.committedStepText = null;
  active.stepReasoningBytes = 0;
  active.finishReason = null;
  active.providerTerminal = false;
  active.toolAssembler = active.toolAssemblerFactory?.() ?? new ToolCallAssembler();
  return reasoningMode;
}
