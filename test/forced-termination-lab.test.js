// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { runChild, runForcedTerminationLab } from '../scripts/forced-termination-lab.js';

test('FAIL-009 forced-termination harness validates real-engine durable prefixes without replay', async () => {
  const report = await runForcedTerminationLab({ maxBoundaries: 12 });
  assert.equal(report.passed, true);
  assert.equal(report.complete_matrix, false);
  assert.equal(report.exercised_boundaries, 12);
  assert.deepEqual(report.cases.map((item) => item.recovered_last_sequence), Array.from({ length: 12 }, (_, index) => index + 1));
  assert.equal(report.cases.every((item) => item.provider_calls_on_resume === 0), true);
  assert.equal(report.cases.every((item) => item.durable_tool_result === false), true);
  assert.equal(JSON.stringify(report).includes('before'), true);
  assert.equal(JSON.stringify(report).includes('Write after'), false);
});

test('forced-termination child timeout kills and observes the child', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
  child.kill = () => {
    child.killed = true;
    queueMicrotask(() => { child.exitCode = 137; child.emit('exit', 137); });
    return true;
  };
  await assert.rejects(runChild([], 'never', {
    spawn: () => child, recordTimeoutMs: 5, cleanupTimeoutMs: 100,
  }), { code: 'forced_termination_child_timeout' });
  assert.equal(child.killed, true);
  assert.equal(child.exitCode, 137);
});
