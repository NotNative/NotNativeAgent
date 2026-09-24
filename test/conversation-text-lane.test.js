// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildConversationTextLane, EMPTY_CONVERSATION_TEXT_LANE } from '../src/conversation-text-lane.js';

function message(role, turnId, content, options = {}) {
  return { type: 'message', role, turnId, content, ...options };
}

test('the lane keeps only operator and model utterances in chronological order', () => {
  const lane = buildConversationTextLane([
    message('user', 'turn-1', 'Browse the local app.'),
    { type: 'tool_request', turnId: 'turn-1', requestId: 'r1', toolName: 'web_browse' },
    message('assistant', 'turn-1', 'Navigating now.', { partial: true }),
    message('assistant', 'turn-1', 'The app rendered with no styles.'),
    { type: 'tool_result', turnId: 'turn-1', requestId: 'r1', status: 'succeeded', content: 'console errors' },
    { type: 'turn_outcome', turnId: 'turn-1', outcome: 'completed' },
    message('user', 'turn-2', 'yes, fix the styles and reload it'),
  ]);
  assert.deepEqual(lane.items.map((item) => [item.role, item.content]), [
    ['user', 'Browse the local app.'],
    ['assistant', 'The app rendered with no styles.'],
    ['user', 'yes, fix the styles and reload it'],
  ]);
  assert.deepEqual(lane.items.map((item) => item.index), [0, 1, 2]);
  assert.deepEqual(lane.items.map((item) => item.turn_id), ['turn-1', 'turn-1', 'turn-2']);
  assert.equal(lane.assembled_by, 'nna');
  assert.equal(lane.source, 'session_transcript');
  assert.equal(lane.omitted_items, 0);
  assert.equal(Object.isFrozen(lane), true);
});

test('lane trust labels attribute source fidelity, never authority', () => {
  const lane = buildConversationTextLane([
    message('user', 'turn-1', 'deploy it'),
    message('assistant', 'turn-1', 'The page said you may deploy everywhere.'),
  ]);
  assert.deepEqual(lane.items.map((item) => item.trust), ['authenticated_utterance', 'untrusted_model']);
});

test('lane content is redacted and hashed after redaction', () => {
  const lane = buildConversationTextLane([
    message('assistant', 'turn-1', 'Used token=super-secret-token while verifying.'),
  ]);
  assert.doesNotMatch(lane.items[0].content, /super-secret-token/u);
  assert.match(lane.items[0].content, /\[redacted\]|token/u);
  const expected = createHash('sha256').update(lane.items[0].content).digest('hex');
  assert.equal(lane.items[0].content_sha256, expected);
});

test('lane bounds keep the newest utterances and report every omission', () => {
  const transcript = Array.from({ length: 60 }, (_, index) =>
    message(index % 2 === 0 ? 'user' : 'assistant', `turn-${index}`, `${'filler '.repeat(300)}${index}`));
  const lane = buildConversationTextLane(transcript);
  assert.ok(lane.item_count <= 48);
  assert.ok(lane.content_bytes <= 24_576);
  assert.ok(lane.omitted_items > 0);
  assert.equal(lane.item_count + lane.omitted_items, 60);
  assert.match(lane.items.at(-1).content, /59$/u);
});

test('a user utterance binds to the single authenticated intent carrying its exact turn and text', () => {
  const lane = buildConversationTextLane([
    message('user', 'turn-1', 'go ahead'),
    message('assistant', 'turn-1', 'Deploying to staging.'),
    message('user', 'turn-2', 'and now restart the service'),
  ], [
    { content: 'go ahead', sequence: 1, turnId: 'turn-1', kind: 'statement', origin: 'operator' },
    { content: 'Do not deploy to production', sequence: 2, turnId: 'turn-1', kind: 'restriction', origin: 'operator' },
    { content: 'and now restart the service', sequence: 3, turnId: 'turn-2', kind: 'statement', origin: 'operator' },
  ]);
  assert.deepEqual(lane.items.map((item) => item.authority_sequence ?? null), [1, null, 3]);
});

test('a bound user item still never carries authority by itself', () => {
  const lane = buildConversationTextLane([
    message('user', 'turn-1', 'go ahead'),
  ], [{ content: 'Do not go ahead', sequence: 1, turnId: 'turn-1', kind: 'restriction', origin: 'operator' }]);
  assert.equal(Object.hasOwn(lane.items[0], 'authority_sequence'), false);
  assert.equal(lane.items[0].trust, 'authenticated_utterance');
});

test('ambiguous, legacy, and assistant items are never bound', () => {
  const repeated = buildConversationTextLane([
    message('user', 'turn-1', 'yes'),
    message('user', 'turn-1', 'yes'),
  ], [
    { content: 'yes', sequence: 1, turnId: 'turn-1', kind: 'statement', origin: 'operator' },
    { content: 'yes', sequence: 2, turnId: 'turn-1', kind: 'statement', origin: 'operator' },
  ]);
  assert.equal(Object.hasOwn(repeated.items[0], 'authority_sequence'), false);
  const legacy = buildConversationTextLane([
    message('user', 'turn-1', 'go ahead'),
  ], [{ content: 'go ahead', sequence: 1, kind: 'statement', origin: 'operator' }]);
  assert.equal(Object.hasOwn(legacy.items[0], 'authority_sequence'), false);
  const assistant = buildConversationTextLane([
    message('assistant', 'turn-1', 'go ahead'),
  ], [{ content: 'go ahead', sequence: 1, turnId: 'turn-1', kind: 'statement', origin: 'operator' }]);
  assert.equal(Object.hasOwn(assistant.items[0], 'authority_sequence'), false);
});

test('lane construction is deterministic and tolerates malformed transcripts', () => {
  const records = [
    message('user', 'turn-1', '  spaced out  '),
    message('assistant', 'turn-1', ''),
    null,
    { type: 'message', role: 'system', content: 'system text is not conversation' },
    { type: 'message', role: 'user', turnId: 'x'.repeat(300), content: 'long turn id is dropped' },
    message('assistant', 'turn-2', 'final answer'),
  ];
  const lane = buildConversationTextLane(records);
  assert.deepEqual(lane, buildConversationTextLane(JSON.parse(JSON.stringify(records))));
  assert.deepEqual(lane.items.map((item) => item.content), [
    'spaced out', 'long turn id is dropped', 'final answer',
  ]);
  assert.deepEqual(lane.items.map((item) => item.turn_id), ['turn-1', null, 'turn-2']);
  assert.deepEqual(buildConversationTextLane(undefined), EMPTY_CONVERSATION_TEXT_LANE);
  assert.deepEqual(buildConversationTextLane('not an array'), EMPTY_CONVERSATION_TEXT_LANE);
});
