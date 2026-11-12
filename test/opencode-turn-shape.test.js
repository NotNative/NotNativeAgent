// SPDX-License-Identifier: Apache-2.0
/**
 * The final shape of a turn's parts, live and restored.
 *
 * Why a dedicated file: two independent paths assemble the transcript a client
 * renders - the settle synthesis for a live turn, and the journal seed for a
 * restored one. Both used to append the answer after every tool call, and each was
 * fixed separately, so the invariant is asserted on both paths here, where a
 * regression on either side is visible.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAssistantResponse } from '../src/opencode/wire-transcript.js';
import { seedProjectionState } from '../src/opencode/v2-seed.js';

const baseState = () => ({ sessionID: 'ses_x', snapshot: 1, directory: 'D:\\t',
  modelRef: { modelID: 'm', providerID: 'p' },
  info: { id: 'ses_x', model: { id: 'm', providerID: 'p' }, time: { created: 1 }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 }, messages: new Map(), lastOutcome: null });

test('the settle synthesis interleaves the answer where it was written', () => {
  const state = baseState();
  const entry = {
    assistantId: 'msg_a', stepStartId: 'ss', stepFinishId: 'sf', textPartId: 'tp',
    textStart: 100, textEnded: 200, assistantCompleted: 200, finish: 'stop', tokens: null,
    assistantContent: 'It worked.',
    assistantParts: [
      { type: 'tool', id: 'tool_1', name: 'fs_read', time: { created: 150 }, state: { status: 'completed', input: {} } },
      { type: 'tool', id: 'tool_2', name: 'shell_run', time: { created: 300 }, state: { status: 'completed', input: {} } },
    ],
  };
  const response = buildAssistantResponse(state, entry);
  const types = response.parts.map((part) => part.type);
  // Prose starts at 100, first call at 150, second call at 300: call-2 comes after the answer.
  assert.deepEqual(types, ['step-start', 'text', 'tool', 'tool', 'step-finish']);
  assert.equal(response.parts.find((part) => part.type === 'text').text, 'It worked.');
});

test('an answer written between two calls lands between them when settled', () => {
  // The realistic order: prose, call, prose, call. The answer's start time decides.
  const state = baseState();
  const entry = {
    assistantId: 'msg_a', stepStartId: 'ss', stepFinishId: 'sf', textPartId: 'tp',
    textStart: 250, textEnded: 260, assistantCompleted: 260, finish: 'stop', tokens: null,
    assistantParts: [
      { type: 'tool', id: 'tool_1', name: 'fs_read', time: { created: 150 }, state: { status: 'completed', input: {} } },
      { type: 'tool', id: 'tool_2', name: 'shell_run', time: { created: 300 }, state: { status: 'completed', input: {} } },
    ],
  };
  const types = buildAssistantResponse(state, entry).parts.map((part) => part.type);
  assert.deepEqual(types, ['step-start', 'tool', 'text', 'tool', 'step-finish']);
});

test('a restored turn interleaves by journal arrival order', () => {
  const state = baseState();
  // The journal order: call, prose, call. textOrder 1 sits between ordinals 0 and 2.
  seedProjectionState(state, [{
    userText: 'go', text: 'First I read, then I ran.', textOrder: 1,
    createdAt: 1, completedAt: 2, finish: 'stop',
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    tools: new Map([
      ['r1', { type: 'tool', id: 'r1', name: 'fs_read', order: 0, state: { status: 'completed', input: {} } }],
      ['r2', { type: 'tool', id: 'r2', name: 'shell_run', order: 2, state: { status: 'completed', input: {} } }],
    ]),
    userKey: 'u', assistantKey: 'a', idleKey: 'i',
  }]);
  const assistant = [...state.messages.values()].find((message) => message.type === 'assistant');
  assert.deepEqual(assistant.content.map((part) => part.type), ['tool', 'text', 'tool']);
  assert.equal(assistant.content[1].text, 'First I read, then I ran.');
  // No bookkeeping field leaks into the wire shape.
  for (const part of assistant.content) assert.equal('order' in part, false);
});

test('a restored turn without ordinals still renders, answer last', () => {
  // Journals written before ordinals existed have no ordering evidence; the old
  // shape is the only honest fallback for them.
  const state = baseState();
  seedProjectionState(state, [{
    userText: 'go', text: 'answer',
    createdAt: 1, completedAt: 2, finish: 'stop',
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    tools: new Map([['r1', { type: 'tool', id: 'r1', name: 'fs_read', state: { status: 'completed', input: {} } }]]),
    userKey: 'u', assistantKey: 'a', idleKey: 'i',
  }]);
  const assistant = [...state.messages.values()].find((message) => message.type === 'assistant');
  assert.deepEqual(assistant.content.map((part) => part.type), ['tool', 'text']);
});
