// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertProviderRequestManifest, providerRequestManifest,
} from '../src/reliability/request-invariant.js';

const route = { logicalRequestId: 'logical-1', profile: { id: 'provider-1' } };
const active = { turnId: 'turn-1', stepId: 'step-1', logicalRequestId: 'logical-1' };

test('provider request manifest is canonical and records attributed source identities', () => {
  const left = request({ b: 2, a: 1 });
  const right = request({ a: 1, b: 2 });
  const context = [{ role: 'user', content: 'hello', provenance: 'authenticated_submission', trust: 'operator' }];
  const first = providerRequestManifest(left, context, route, active);
  const second = providerRequestManifest(right, context, route, active);
  assert.equal(first.requestFingerprint, second.requestFingerprint);
  assert.equal(first.sources[0].provenance, 'authenticated_submission');
  assert.equal(first.sources[0].trust, 'operator');
  assert.equal(assertProviderRequestManifest(left, first, route, active), true);
});

test('dispatch invariant rejects nested request mutation and route drift', () => {
  const value = request({ a: 1 });
  const manifest = providerRequestManifest(value, [], route, active);
  value.messages[0].content = 'mutated';
  assert.throws(() => assertProviderRequestManifest(value, manifest, route, active), {
    code: 'provider_request_reconstruction_desync',
  });

  const fresh = request({ a: 1 });
  const freshManifest = providerRequestManifest(fresh, [], route, active);
  assert.throws(() => assertProviderRequestManifest(fresh, freshManifest, { ...route, profile: { id: 'other' } }, active), {
    code: 'provider_request_reconstruction_desync',
  });
});

test('manifest creation rejects cyclic or non-JSON request values', () => {
  const cyclic = request({});
  cyclic.messages.push(cyclic);
  assert.throws(() => providerRequestManifest(cyclic, [], route, active), { code: 'provider_request_invalid' });
  const invalid = request({ temperature: Number.NaN });
  assert.throws(() => providerRequestManifest(invalid, [], route, active), { code: 'provider_request_invalid' });
  for (const value of [new Date(), new Map([['key', 'value']]), /pattern/u]) {
    assert.throws(() => providerRequestManifest(request({ metadata: value }), [], route, active), {
      code: 'provider_request_invalid',
    });
  }
});

function request(extra) {
  return {
    model: 'model-1', messages: [{ role: 'user', content: 'hello' }], tools: [{ name: 'read' }],
    temperature: 0, ...extra,
  };
}
