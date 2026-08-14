// SPDX-License-Identifier: Apache-2.0
import { toProviderMessages } from '../context.js';
import { ToolCallAssembler } from '../tools/calls.js';
import { toolCatalogContext } from '../tools/catalog-context.js';
import { routeReasoningFields } from '../provider/reasoning.js';

export function providerRequest(engine, route, context, options = {}) {
  const messages = toProviderMessages(context);
  const dialect = engine.dialects?.instructions(route);
  const tools = engine.tools.providerDefinitions(toolQuery(context));
  const catalog = toolCatalogContext(engine.tools.snapshot?.() ?? [], tools);
  const system = [dialect, catalog].filter(Boolean).map((content) => ({ role: 'system', content }));
  return Object.freeze({
    model: route.model, messages: [...system, ...messages],
    tools, temperature: route.temperature,
    maxOutputTokens: route.maxOutputTokens,
    ...routeReasoningFields(route),
    ...(options.reasoningMode ? { reasoningMode: options.reasoningMode } : {}),
  });
}

function toolQuery(context) {
  return [...context].reverse().find((item) => item.trust === 'operator')?.content ?? '';
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
  const reasoningMode = active.reasoningFallbackPending ? 'off' : undefined;
  active.reasoningFallbackPending = false;
  active.stepText = '';
  active.committedStepText = null;
  active.stepReasoningBytes = 0;
  active.finishReason = null;
  active.providerTerminal = false;
  active.toolAssembler = new ToolCallAssembler();
  return reasoningMode;
}
