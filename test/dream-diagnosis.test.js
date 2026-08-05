// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnoseDreamEvidence } from '../src/dream-diagnosis.js';

test('idle diagnosis quarantines uncertain turns and classifies repeated stable reasons', () => {
  const diagnosis = diagnoseDreamEvidence([
    { turn_id: 'one', status: 'succeeded', reason_code: null },
    { turn_id: 'two', status: 'timed_out', reason_code: 'provider_timeout' },
    { turn_id: 'two', status: 'failed', reason_code: 'provider_timeout' },
    { turn_id: 'three', status: 'failed', reason_code: 'provider_timeout' },
  ]);
  assert.equal(diagnosis.status, 'attention');
  assert.equal(diagnosis.turns, 3);
  assert.equal(diagnosis.eligible_turns, 1);
  assert.equal(diagnosis.quarantined_turns, 2);
  assert.ok(diagnosis.issues.some((issue) => issue.code === 'terminal_timed_out'));
  assert.ok(diagnosis.issues.some((issue) => issue.code === 'repeated_reason' && issue.count === 3));
});

test('idle diagnosis reports clean evidence without inventing issues', () => {
  const diagnosis = diagnoseDreamEvidence([{ turn_id: 'one', status: 'succeeded', reason_code: null }]);
  assert.equal(diagnosis.status, 'clean');
  assert.equal(diagnosis.quarantined_turns, 0);
  assert.deepEqual(diagnosis.issues, []);
});
