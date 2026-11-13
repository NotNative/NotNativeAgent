// SPDX-License-Identifier: Apache-2.0
// Failure-path tests for the v2 transcript ordering contract: prose blocks and
// tool rows must stay in the order the model produced them, both in the stored
// message and in the events the client renders from.
import assert from 'node:assert/strict';
import test from 'node:test';
import { observeV1Event } from '../src/opencode/v2-projection.js';

/** A session state shaped the way the v2 workspace builds one. */
function sessionState() {
  return {
    info: { id: 'ses_order', title: 'Ordering', model: { id: 'm', providerID: 'p' }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 }, outcome: 'succeeded' },
    running: false, messages: new Map(), inputs: new Map(), inbox: new Map(), forms: new Map(),
    pending: new Set(), cancelled: new Set(), failureCode: null,
  };
}

/** Collect every event the projection publishes, in order. `emit` is handed to
 *  the projection as the events object itself, so it must be the function. */
function recorder() {
  const emitted = [];
  const emit = (_state, type, properties) => {
    emitted.push({ type, properties });
    return { id: `evt_${emitted.length}`, created: emitted.length };
  };
  return { emitted, emit };
}

function textPart(id, text, messageID, ended = false) {
  return { id, messageID, sessionID: 'ses_order', type: 'text', text,
    time: { start: 1, ...(ended ? { end: 2 } : {}) } };
}

function toolPart(id, name, messageID, status = 'running') {
  return { id, messageID, sessionID: 'ses_order', type: 'tool', name, time: { created: 1 },
    state: { status, input: {}, metadata: {} } };
}

test('prose written between tool calls keeps its own part and its own ordinal', () => {
  const state = sessionState();
  const events = recorder();
  const assistantId = 'msg_a';
  observeV1Event(state, { type: 'message.updated', properties: { info: {
    id: assistantId, sessionID: 'ses_order', role: 'assistant', time: { created: 1 } } } }, events);

  // The shape from a real operator report: prose, a call, more prose, more calls.
  observeV1Event(state, { type: 'message.part.updated', properties: { part: textPart('prt_1', 'first prose', assistantId) } }, events);
  observeV1Event(state, { type: 'message.part.updated', properties: { part: toolPart('prt_t1', 'shell', assistantId) } }, events);
  observeV1Event(state, { type: 'message.part.updated', properties: { part: textPart('prt_2', 'second prose', assistantId, true) } }, events);
  observeV1Event(state, { type: 'message.part.updated', properties: { part: toolPart('prt_t2', 'shell', assistantId) } }, events);

  const message = state.messages.get(assistantId);
  // Why the exact sequence: this is the ordering the operator sees. Two prose
  // blocks that collapse into one put everything above the tool rows.
  assert.deepEqual(message.content.map((part) => part.type), ['text', 'tool', 'text', 'tool'],
    `transcript order was ${JSON.stringify(message.content.map((p) => p.type))}`);
  assert.equal(message.content[0].text, 'first prose');
  assert.equal(message.content[2].text, 'second prose');

  // Compatibility: the client builds a part id as `${messageID}:text:${ordinal}`,
  // so two prose blocks sharing an ordinal render as one block. The ordinals the
  // events carried are what decide that, not the ids NNA stored.
  const textEvents = events.emitted.filter((event) => event.type.startsWith('session.text.'));
  const ordinals = textEvents.map((event) => event.properties.ordinal);
  assert.deepEqual(ordinals, [0, 1], `text events carried ordinals ${JSON.stringify(ordinals)}`);
  assert.equal(new Set(ordinals).size, ordinals.length, 'each prose block must have a distinct ordinal');
});

test('a streamed delta grows the segment it names, not the turn-opening block', () => {
  const state = sessionState();
  const events = recorder();
  const assistantId = 'msg_b';
  observeV1Event(state, { type: 'message.updated', properties: { info: {
    id: assistantId, sessionID: 'ses_order', role: 'assistant', time: { created: 1 } } } }, events);

  observeV1Event(state, { type: 'message.part.updated', properties: { part: textPart('prt_1', 'layer 41', assistantId) } }, events);
  observeV1Event(state, { type: 'message.part.updated', properties: { part: toolPart('prt_t1', 'shell', assistantId) } }, events);
  observeV1Event(state, { type: 'message.part.updated', properties: { part: textPart('prt_2', '', assistantId) } }, events);
  // The second block streams the line the operator reported arriving out of place.
  observeV1Event(state, { type: 'message.part.delta', properties: {
    sessionID: 'ses_order', messageID: assistantId, partID: 'prt_2', field: 'text', delta: '/48 - nearly there' } }, events);

  const message = state.messages.get(assistantId);
  assert.equal(message.content[0].text, 'layer 41', 'the opening block must not absorb a later segment');
  assert.equal(message.content[2].text, '/48 - nearly there', 'the delta must land in the segment it names');
  const delta = events.emitted.find((event) => event.type === 'session.text.delta');
  assert.equal(delta.properties.ordinal, 1, 'the delta must name the ordinal the client renders into');
});

test('an unknown delta still lands somewhere visible rather than vanishing', () => {
  const state = sessionState();
  const events = recorder();
  const assistantId = 'msg_c';
  observeV1Event(state, { type: 'message.updated', properties: { info: {
    id: assistantId, sessionID: 'ses_order', role: 'assistant', time: { created: 1 } } } }, events);
  observeV1Event(state, { type: 'message.part.updated', properties: { part: textPart('prt_1', 'prose', assistantId) } }, events);
  // A delta whose part never announced itself: some engines stream before the
  // part-updated frame. Dropping it would lose operator-visible text.
  observeV1Event(state, { type: 'message.part.delta', properties: {
    sessionID: 'ses_order', messageID: assistantId, partID: 'prt_unannounced', field: 'text', delta: ' tail' } }, events);
  const message = state.messages.get(assistantId);
  const texts = message.content.filter((part) => part.type === 'text').map((part) => part.text);
  assert.ok(texts.join('').includes('tail'), `delta was lost: ${JSON.stringify(texts)}`);
});
