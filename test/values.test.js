// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { deepFreeze, isRecord, positiveInteger } from '../src/values.js';
import { SHA256_HEX, sha256Hex } from '../src/digests.js';
import { elapsedMs } from '../src/timing.js';

test('isRecord accepts plain records only', () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord(Object.create(null)), true);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord('value'), false);
});

test('deepFreeze handles cycles and shared references without recursing', () => {
  const shared = { value: 1 };
  const root = { shared, other: shared };
  root.self = root;
  assert.equal(deepFreeze(root), root);
  assert.equal(Object.isFrozen(root), true);
  assert.equal(Object.isFrozen(shared), true);
  assert.equal(Object.isFrozen(root.self), true);
});

test('positiveInteger accepts only positive safe integers', () => {
  assert.equal(positiveInteger(1), 1);
  assert.equal(positiveInteger(0), null);
  assert.equal(positiveInteger(-1), null);
  assert.equal(positiveInteger(1.5), null);
  assert.equal(positiveInteger('1'), null);
});

test('sha256Hex and its grammar agree', () => {
  const digest = sha256Hex('abc');
  assert.equal(digest, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(SHA256_HEX.test(digest), true);
  assert.equal(SHA256_HEX.test(digest.toUpperCase()), false);
});

test('elapsedMs measures a non-negative duration', () => {
  const started = process.hrtime.bigint();
  const value = elapsedMs(started);
  assert.equal(typeof value, 'number');
  assert.equal(Number.isFinite(value), true);
  assert.equal(value >= 0, true);
});
