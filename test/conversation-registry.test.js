// SPDX-License-Identifier: Apache-2.0
// The session-id to conversation-state registry: the seam a resident engine
// resolves conversation identities through. Attaching, resolving, detaching,
// and the failure paths are pinned here because the central-engine slices
// build on these contracts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationRegistry, ConversationState } from '../src/engine/conversation-state.js';
import { SessionEngine } from '../src/engine.js';
import { resolveManifest } from '../src/config.js';

test('attach, resolve, and detach round-trip a conversation identity', () => {
  const registry = new ConversationRegistry();
  const state = registry.attach('session_a');
  assert.ok(state instanceof ConversationState);
  assert.equal(registry.resolve('session_a'), state);
  assert.equal(registry.has('session_a'), true);
  assert.deepEqual(registry.ids(), ['session_a']);
  assert.equal(registry.size(), 1);
  registry.detach('session_a');
  assert.equal(registry.has('session_a'), false);
  assert.equal(registry.size(), 0);
});

test('a duplicate attach and a missing resolve or detach are typed refusals', () => {
  const registry = new ConversationRegistry();
  registry.attach('session_a');
  assert.throws(() => registry.attach('session_a'), { code: 'session_duplicate' });
  assert.throws(() => registry.resolve('session_b'), { code: 'session_missing' });
  assert.throws(() => registry.detach('session_b'), { code: 'session_missing' });
  assert.throws(() => registry.attach(''), { code: 'session_id_invalid' });
});

test('an engine hosts its primary conversation under its own session id', () => {
  const engine = new SessionEngine({ config: resolveManifest({ persistence: 'ephemeral',
    provider: { id: 'test', endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture-model', trust_zone: 'loopback' } }) });
  assert.equal(engine.conversations.size(), 1);
  // The resolved state IS the state the accessors expose: one source of truth.
  const resolved = engine.conversations.resolve(engine.sessionId);
  assert.equal(resolved.transcript, engine.transcript);
  assert.equal(resolved.state, engine.state);
  assert.equal(resolved.authority, engine.authority);
});

function resolveTestConfig() {
  // Kept for future multi-conversation registry tests on this file.
  return resolveManifest({ persistence: 'ephemeral',
    provider: { id: 'test', endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture-model', trust_zone: 'loopback' } });
}
