// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';

export function chatCompletionBody(profile, request, responseFormat, reasoningControls) {
  return {
    model: request.model, messages: normalizeSystemMessages(request.messages ?? []), stream: true,
    ...(Number.isFinite(request.temperature) ? { temperature: request.temperature } : {}),
    ...(profile.capabilities?.usage === false ? {} : { stream_options: { include_usage: true } }),
    ...(Number.isInteger(request.maxOutputTokens) ? { max_tokens: request.maxOutputTokens } : {}),
    ...(request.tools?.length ? {
      tools: request.tools, tool_choice: 'auto',
      ...(typeof request.parallelToolCalls === 'boolean' ? { parallel_tool_calls: request.parallelToolCalls } : {}),
    } : {}),
    ...(responseFormat ? { response_format: responseFormat } : {}), ...reasoningControls,
  };
}

function normalizeSystemMessages(messages) {
  if (!Array.isArray(messages)) throw new ContractError('provider_messages_invalid', 'provider messages must be an array');
  const system = [], conversation = []; let firstSystem = null;
  for (const message of messages) {
    if (message?.role !== 'system') { conversation.push(message); continue; }
    if (typeof message.content !== 'string') {
      throw new ContractError('provider_system_message_invalid', 'provider system message content must be text');
    }
    firstSystem ??= message;
    system.push(message.content);
  }
  return system.length === 0 ? conversation : [{ ...firstSystem, content: system.join('\n\n') }, ...conversation];
}
