// SPDX-License-Identifier: Apache-2.0
import { SessionEngine } from '../src/engine.js';

let declarationSequence = 0;

export class TypedSessionEngine extends SessionEngine {
  constructor(options) {
    const factory = options.providerFactory;
    const pending = new Map();
    super({ ...options, providerFactory: factory
      ? (...args) => typedTerminalProvider(factory(...args), pending) : factory });
  }
}

// Adapts legacy scripted providers so their terminal prose does not bypass the production
// turn.finish protocol. This belongs only to tests that are exercising a different boundary.
export function typedTerminalProvider(provider, pending = new Map()) {
  const wrapper = Object.create(provider);
  wrapper.stream = async function* stream(request, ...args) {
    const replayKey = pendingDeclarationId(request.messages);
    if (replayKey && pending.has(replayKey)) {
      const events = pending.get(replayKey); pending.delete(replayKey);
      for (const event of events) yield event;
      return;
    }
    const events = [];
    for await (const event of provider.stream(request, ...args)) {
      if (['usage', 'reasoning'].includes(event.type)) yield event;
      else events.push(event);
    }
    if (!supportsFinish(request) || currentTurnDeclared(request.messages) || !isTerminalTextStep(events)) {
      for (const event of events) yield event;
      return;
    }
    declarationSequence += 1;
    const declarationId = `fixture-finish-${declarationSequence}`;
    pending.set(declarationId, events);
    const declaration = declarationFor(events, request);
    yield { type: 'tool_fragment', fragments: [{
      index: 0, id: declarationId,
      function: { name: 'turn.finish', arguments: JSON.stringify(declaration) },
    }] };
    yield { type: 'terminal', finishReason: 'tool_calls' };
  };
  return wrapper;
}

function pendingDeclarationId(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const call = messages[index].tool_calls?.find((item) => item.function?.name === 'turn.finish');
    if (call) return call.id;
  }
  return null;
}

function supportsFinish(request) {
  return !request.responseFormat && request.tools?.some((tool) => tool.function?.name === 'turn.finish') === true;
}

function currentTurnDeclared(messages = []) {
  let latestUser = -1;
  for (let index = 0; index < messages.length; index += 1) if (messages[index].role === 'user') latestUser = index;
  return messages.slice(latestUser + 1).some((message) => message.tool_calls
    ?.some((call) => call.function?.name === 'turn.finish'));
}

function isTerminalTextStep(events) {
  return events.some((event) => event.type === 'terminal')
    && events.some((event) => event.type === 'text' && event.text?.trim())
    && !events.some((event) => event.type === 'tool_fragment');
}

function declarationFor(events, request) {
  const text = events.filter((event) => event.type === 'text').map((event) => event.text).join(' ');
  const toolEvidence = request.messages?.filter((message) => message.role === 'tool')
    .map((message) => message.content).join(' ') ?? '';
  if (/"(?:status|tool_lifecycle_status)":"(?:denied|failed)"/u.test(toolEvidence)) {
    return { outcome: 'blocked', reason_code: 'fixture_terminal_tool_failure' };
  }
  if (/\b(?:blocked|cannot continue|can't continue|unable to continue|denied)\b/iu.test(text)) {
    return { outcome: 'blocked', reason_code: 'fixture_terminal_blocker' };
  }
  if (/\?\s*$/u.test(text)) return { outcome: 'needs_input', question: text.trim().slice(-1024) };
  return { outcome: 'completed' };
}
