// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { CanonicalIngress } from '../src/ingress.js';

function cancel(requestId) {
  return { version: '1.0', type: 'cancel', request_id: requestId };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('ingress evicts only settled identities when its duplicate window fills', async () => {
  const operations = new Map();
  const ingress = new CanonicalIngress({ cancel(command) {
    const operation = deferred();
    operations.set(command.request_id, operation);
    return operation.promise;
  } }, { maxIdentities: 2 });
  const first = ingress.start(cancel('first'));
  const second = ingress.start(cancel('second'));
  assert.throws(() => ingress.start(cancel('third')), { code: 'ingress_capacity' });
  assert.deepEqual(ingress.start(cancel('first')).result, { accepted: false, duplicate: true, pending: true });

  operations.get('first').resolve({ accepted: true });
  await first.operation;
  const third = ingress.start(cancel('third'));
  assert.equal(third.duplicate, false);
  assert.deepEqual(ingress.start(cancel('second')).result, { accepted: false, duplicate: true, pending: true });
  assert.throws(() => ingress.start(cancel('fourth')), { code: 'ingress_capacity' });

  operations.get('second').resolve({ accepted: true });
  operations.get('third').resolve({ accepted: true });
  await Promise.all([second.operation, third.operation]);
  assert.deepEqual(ingress.start(cancel('third')).result, { accepted: false, duplicate: true, pending: false });
  const fourth = ingress.start(cancel('fourth'));
  operations.get('fourth').resolve({ accepted: true });
  await fourth.operation;
});

test('ingress retains rejected request identities while they remain in its window', async () => {
  let attempts = 0;
  const ingress = new CanonicalIngress({ cancel() {
    attempts += 1;
    return Promise.reject(new Error('output failed after cancel took effect'));
  } }, { maxIdentities: 2 });
  const first = ingress.start(cancel('uncertain'));
  await assert.rejects(first.operation, /output failed/u);
  assert.deepEqual(ingress.start(cancel('uncertain')).result,
    { accepted: false, duplicate: true, pending: false });
  assert.equal(attempts, 1);
});

test('a live ingress continues accepting more controls than its duplicate capacity', async () => {
  let attempts = 0;
  const ingress = new CanonicalIngress({ async cancel() {
    attempts += 1;
    return { accepted: true };
  } }, { maxIdentities: 2 });
  for (let index = 0; index < 16; index += 1) {
    assert.deepEqual(await ingress.submit(cancel(`request-${index}`)), { accepted: true });
  }
  assert.equal(attempts, 16);
});
