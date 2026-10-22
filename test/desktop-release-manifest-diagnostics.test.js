// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { appendManifestDiagnostics } from '../desktop/scripts/release-manifest-diagnostics.mjs';

test('manifest diagnostics retain earlier gate failures while bounding new differences', () => {
  const errors = ['quality gates failed'];
  const mismatches = Array.from({ length: 45 }, (_, index) => [`file-${index}`, 'hash']);
  appendManifestDiagnostics(errors, { mismatches, stale: ['stale-file'] },
    ['missing-file'], new Map());
  assert.equal(errors[0], 'quality gates failed');
  assert.equal(errors.length, 42);
  assert.equal(errors[1], 'release artifact mismatch: file-0');
  assert.equal(errors[40], 'release artifact mismatch: file-39');
  assert.equal(errors[41], '7 additional release manifest discrepancies omitted');
});

test('manifest diagnostics report each difference when below the bound', () => {
  const errors = [];
  appendManifestDiagnostics(errors, { mismatches: [['changed', 'hash']], stale: ['removed'] },
    ['changed', 'added'], new Map([['changed', 'hash']]));
  assert.deepEqual(errors, [
    'release artifact mismatch: changed',
    'manifest missing file: added',
    'manifest references missing file: removed',
  ]);
});
