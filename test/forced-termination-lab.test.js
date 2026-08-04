// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { runForcedTerminationLab } from '../scripts/forced-termination-lab.js';

test('FAIL-009 forced-termination harness validates real-engine durable prefixes without replay', async () => {
  const report = await runForcedTerminationLab({ maxBoundaries: 3 });
  assert.equal(report.passed, true);
  assert.equal(report.complete_matrix, false);
  assert.equal(report.exercised_boundaries, 3);
  assert.deepEqual(report.cases.map((item) => item.recovered_last_sequence), [1, 2, 3]);
  assert.equal(report.cases.every((item) => item.provider_calls_on_resume === 0), true);
  assert.equal(JSON.stringify(report).includes('before'), true);
  assert.equal(JSON.stringify(report).includes('Write after'), false);
});
