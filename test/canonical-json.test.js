// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '../src/canonical-json.js';

test('canonical JSON sorts object keys at every depth', () => {
  const value = { z: 1, a: { y: [3, { b: 2, a: 1 }], x: true }, n: null };
  assert.equal(canonicalJson(value),
    '{"a":{"x":true,"y":[3,{"a":1,"b":2}]},"n":null,"z":1}');
});

test('canonical JSON preserves array order and escapes keys', () => {
  assert.equal(canonicalJson([3, 1, { 'a"b': 2 }]), '[3,1,{"a\\"b":2}]');
});

test('a cycle is reported to the caller policy', () => {
  const value = { name: 'root' };
  value.self = value;
  assert.throws(() => canonicalJson(value), { code: 'canonical_json_invalid' });
  assert.equal(canonicalJson(value, {
    onInvalid: (reason, current) => reason === 'cycle' ? '"[cycle]"' : JSON.stringify(current),
  }), '{"name":"root","self":"[cycle]"}');
});

test('non-finite numbers and unsupported values follow the caller policy', () => {
  assert.throws(() => canonicalJson({ value: Number.NaN }), { code: 'canonical_json_invalid' });
  assert.equal(canonicalJson({ value: Number.NaN }, {
    onInvalid: (reason, current) => reason === 'non_finite' ? JSON.stringify(current) : 'null',
  }), '{"value":null}');
  assert.equal(canonicalJson({ missing: undefined }, {
    onInvalid: (reason, current) => reason === 'unsupported' ? JSON.stringify(current) : 'null',
  }), '{"missing":undefined}');
});

test('the depth bound is explicit and reportable', () => {
  const deep = { a: { b: { c: { d: 1 } } } };
  assert.throws(() => canonicalJson(deep, { maxDepth: 2 }), { code: 'canonical_json_invalid' });
  assert.equal(canonicalJson(deep, { maxDepth: 2, onInvalid: () => '"[bound]"' }),
    '{"a":{"b":{"c":"[bound]"}}}');
});
