// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { auditRecords, loadRecords, STATUSES } from './feature-parity-records.mjs';

test('every W item has exactly one honest acceptance record pinned to the table', async () => {
  const { problems, expected, recorded } = await auditRecords();
  assert.deepEqual(problems, [], problems.join('; '));
  assert.equal(expected, 117);
  assert.equal(recorded, 117);
});

test('status moves require evidence and the vocabulary stays closed', async () => {
  const { records, statuses } = await loadRecords();
  assert.deepEqual([...statuses].sort(), [...STATUSES].sort());
  for (const record of records) {
    if (record.status === 'verified') {
      assert.ok(record.evidence.some((entry) => /installed|V[1-6]/u.test(entry)),
        `${record.id} claims verified without installed/V evidence`);
    }
  }
});

test('no record claims completion while MVP closure requires installed evidence', async () => {
  const { records } = await loadRecords();
  const claimed = records.filter((record) => record.status === 'verified').map((record) => record.id);
  // V4 promotes rows only after installed evidence; until that observation
  // run exists, nothing may claim verified.
  assert.deepEqual(claimed, [], `unverified installed observations: ${claimed.join(', ')}`);
});
