// SPDX-License-Identifier: Apache-2.0
import { toProviderMessages } from './context.js';
import { ToolCallAssembler } from './tool-calls.js';

export function providerRequest(engine, route, context) {
  const messages = toProviderMessages(context);
  const dialect = engine.dialects?.instructions(route);
  return Object.freeze({
    model: route.model, messages: dialect ? [{ role: 'system', content: dialect }, ...messages] : messages,
    tools: engine.tools.providerDefinitions(toolQuery(context)), temperature: route.temperature,
    maxOutputTokens: route.maxOutputTokens,
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
  active.stepText = '';
  active.finishReason = null;
  active.providerTerminal = false;
  active.toolAssembler = new ToolCallAssembler();
}
