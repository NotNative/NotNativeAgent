// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { explicitSkillRequests } from '../src/skill-opportunity.js';

test('skill opportunities require explicit operator requests and reject secrets', () => {
  const records = [
    message('t1', 'I used a website to compare prices.'),
    message('t2', 'Please package this price comparison process into a reusable skill.'),
    message('t3', 'Create a login skill with token=do-not-store-this.'),
    { ...message('t4', 'Create a research skill.'), role: 'assistant', trust: 'model' },
  ];
  assert.deepEqual(explicitSkillRequests(records, ['t1', 't2', 't3', 't4']), [
    { turnId: 't2', request: 'Please package this price comparison process into a reusable skill.' },
  ]);
});

test('skill opportunity scan is bounded to the sealed turn set', () => {
  const records = [message('inside', 'Build a deep research skill.'), message('outside', 'Build a deployment skill.')];
  assert.deepEqual(explicitSkillRequests(records, ['inside']), [
    { turnId: 'inside', request: 'Build a deep research skill.' },
  ]);
});

function message(turnId, content) {
  return { type: 'message', role: 'user', trust: 'operator', turnId, content };
}
