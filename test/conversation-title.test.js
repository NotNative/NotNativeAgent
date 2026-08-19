// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveConversationTitle, isGeneratedConversationName } from '../src/experience/conversation-title.js';

const user = (content) => ({ type: 'message', role: 'user', content });

test('conversation titles extract a terse local topic from operator language', () => {
  assert.equal(deriveConversationTitle([user('Please diagnose the Telegram gateway logs for me.')]), 'Telegram Gateway Logs');
  assert.equal(deriveConversationTitle([user("I need your insight as to what's failing on the health check.")]), 'Health Check');
  assert.equal(deriveConversationTitle([user('Qwen commands are getting mangled by PowerShell escaping.')]), 'Qwen Commands PowerShell');
});

test('conversation titles wait through greetings and use at most the first two user turns', () => {
  assert.equal(deriveConversationTitle([user('Hello')]), null);
  assert.equal(deriveConversationTitle([user('Hello'), user('Please inspect provider routing failures.')]), 'Provider Routing Failures');
  assert.equal(deriveConversationTitle([
    user('Hello'), user('Please inspect provider routing failures.'), user('Unrelated database migration'),
  ]), 'Provider Routing Failures');
});

test('conversation titles discard URLs, code blocks, repeats, and generated shell names', () => {
  assert.equal(deriveConversationTitle([user('Look at https://example.test and ```secret token``` Telegram Telegram delivery')]), 'Telegram Delivery');
  assert.equal(isGeneratedConversationName('Main'), true);
  assert.equal(isGeneratedConversationName('Conversation 4'), true);
  assert.equal(isGeneratedConversationName('Provider Routing'), false);
});
