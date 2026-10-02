// SPDX-License-Identifier: Apache-2.0
import { tokenUsage } from './v2-contract.js';
import { observeForm } from './v2-forms.js';

export function observeV1Event(state, event, events) {
  const { type, properties: value } = event;
  if (type.startsWith('question.')) return observeForm(state, type, value, events);
  if (type === 'message.updated') return observeMessage(state, value.info, events);
  if (type === 'message.part.updated') return observePart(state, value.part, events);
  if (type === 'message.part.delta') return observeDelta(state, value, events);
  if (type === 'session.status' && value.status.type === 'busy') {
    state.running = true;
    events.emit(state, 'session.execution.started', { sessionID: state.info.id });
  }
  if (type === 'session.idle') finishExecution(state, events);
}

function observeMessage(state, info, events) {
  if (state.cancelled.has(info.id) || state.cancelled.has(info.parentID)) return;
  if (info.role === 'user') {
    if (!state.messages.has(info.id)) state.messages.set(info.id, { id: info.id, type: 'user', time: info.time, text: '' });
    return;
  }
  if (!state.messages.has(info.id)) {
    state.messages.set(info.id, { id: info.id, type: 'assistant', agent: 'build', model: state.info.model,
      time: { created: info.time.created ?? Date.now() }, content: [] });
    events.emit(state, 'session.step.started', { sessionID: state.info.id, assistantMessageID: info.id,
      agent: 'build', model: state.info.model, started: info.time.created ?? Date.now() });
    const inbox = state.inbox.get(info.parentID);
    if (inbox) {
      state.inbox.delete(info.parentID);
      events.emit(state, 'session.inbox.delivered', { sessionID: state.info.id, inboxID: info.parentID });
    }
  }
  if (info.time.completed) finishMessage(state, info, events);
}

function finishMessage(state, info, events) {
  const message = state.messages.get(info.id);
  if (message.time.completed) return;
  message.time.completed = info.time.completed;
  message.finish = info.finish === 'abort' ? 'stop' : info.finish;
  message.tokens = tokenUsage(info.tokens); message.cost = info.cost ?? 0;
  state.lastOutcome = info.finish === 'abort' ? 'interrupted' : info.finish === 'error' ? 'failed' : 'succeeded';
  const data = { sessionID: state.info.id, assistantMessageID: info.id, cost: message.cost, tokens: message.tokens };
  if (info.finish === 'error') {
    message.error = { type: 'nna_execution_failed', message: 'NNA could not complete the turn' };
    events.emit(state, 'session.step.failed', { ...data, error: message.error });
  } else events.emit(state, 'session.step.ended', { ...data, finish: message.finish });
  for (const key of ['input', 'output', 'reasoning']) state.info.tokens[key] += message.tokens[key];
  for (const key of ['read', 'write']) state.info.tokens.cache[key] += message.tokens.cache[key];
  state.info.cost += message.cost;
}

function observePart(state, part, events) {
  if (part.type !== 'text') return;
  const message = state.messages.get(part.messageID);
  if (!message) return;
  if (message.type === 'user') {
    message.text = part.text;
    const input = state.inputs.get(message.id) ?? {};
    if (input.metadata) message.metadata = input.metadata;
    const item = { id: message.id, sessionID: state.info.id, time: message.time, type: 'user',
      payload: { text: part.text, ...(input.metadata ? { metadata: input.metadata } : {}) }, delivery: input.delivery ?? 'queue' };
    state.inbox.set(message.id, item);
    events.emit(state, 'session.inbox.enqueued', { sessionID: state.info.id, inboxID: message.id,
      item: { type: 'user', payload: item.payload, delivery: item.delivery } });
    return;
  }
  message.content = [{ type: 'text', text: part.text }];
  events.emit(state, part.time?.end == null ? 'session.text.started' : 'session.text.ended', {
    sessionID: state.info.id, assistantMessageID: message.id, ordinal: 0,
    ...(part.time?.end == null ? {} : { text: part.text }),
  });
}

function observeDelta(state, value, events) {
  const message = state.messages.get(value.messageID);
  if (message?.type === 'assistant') {
    if (!message.content.length) message.content.push({ type: 'text', text: '' });
    message.content[0].text += value.delta;
  }
  events.emit(state, 'session.text.delta', { sessionID: state.info.id, assistantMessageID: value.messageID,
    ordinal: 0, delta: value.delta }, false);
}

function finishExecution(state, events) {
  state.running = false;
  state.info.outcome = state.lastOutcome ?? 'succeeded';
  state.info.time.idle = Date.now(); state.info.time.updated = state.info.time.idle;
  const extra = state.info.outcome === 'interrupted' ? { reason: 'user' }
    : state.info.outcome === 'failed' ? { error: { type: 'nna_execution_failed', message: 'NNA could not complete the turn' } } : {};
  events.emit(state, `session.execution.${state.info.outcome}`, { sessionID: state.info.id, ...extra });
  events.emit(state, 'session.usage.updated', { sessionID: state.info.id, cost: state.info.cost, tokens: state.info.tokens }, false);
}
