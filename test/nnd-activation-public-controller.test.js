// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ContractError } from '../src/ids.js';

async function fixture({ verifyFails = false, attachFails = false, attachChanges = false } = {}) {
  const trace = [];
  const state = { unpublishedTrial: true, retained: true, retainedLeaseArmed: true,
    nativeAdmissionTransferred: true, published: false, stopping: false,
    controller: { isListening: () => true }, native: { isListening: () => true },
    record: { instance_id: 'generation' }, activationOperationId: 'operation', identity: {}, lease: {} };
  const registryLease = {};
  const dependencies = { ContractError,
    verifyNndClearedAdmissionUnderOwnership: async (_identity, subject, _serviceLease, registry, options, publish) => {
      assert.equal(subject, state); assert.equal(registry, registryLease);
      assert.equal(options.operationId, 'operation');
      trace.push('verify');
      if (verifyFails) throw new Error('cleared witness changed');
      publish(); trace.push('published');
    },
    requestNndController: async (record, action) => {
      trace.push('attach'); assert.equal(record, state.record); assert.equal(action, 'attach');
      assert.equal(state.published, true);
      if (attachFails) throw new Error('controller did not respond');
      if (attachChanges) state.stopping = true;
      return { generation: 'generation', endpoint: 'http://127.0.0.1:1000' };
    } };
  const source = await readFile(new URL('../src/nnd-activation-public-controller.js', import.meta.url), 'utf8');
  const executable = source.replace(/^import\s[\s\S]*?;\r?\n/gm, '').replaceAll('export async function', 'async function');
  const api = Function(...Object.keys(dependencies), `${executable}\nreturn {publishRetainedNndController};`)(...Object.values(dependencies));
  return { state, registryLease, trace, publish: options => api.publishRetainedNndController(state,
    registryLease, options ?? { operationId: 'operation' }) };
}

test('exact cleared-owner proof opens controller and verifies ordinary attach', async () => {
  const f = await fixture();
  assert.deepEqual(await f.publish(), { state: 'public_controller_attached', operation_id: 'operation',
    generation: 'generation', endpoint: 'http://127.0.0.1:1000' });
  assert.deepEqual(f.trace, ['verify', 'published', 'attach']);
  await assert.rejects(f.publish(), { code: 'nnd_activation_public_controller_invalid' });
});

test('early native gate, failed witness, or changed listener never exposes a controller', async () => {
  const early = await fixture(); early.state.nativeAdmissionTransferred = false;
  await assert.rejects(early.publish(), { code: 'nnd_activation_public_controller_invalid' });
  assert.deepEqual(early.trace, []);
  const invalid = await fixture({ verifyFails: true });
  await assert.rejects(invalid.publish(), { code: 'nnd_activation_public_controller_invalid' });
  assert.equal(invalid.state.published, false);
  await assert.rejects(invalid.publish(), { code: 'nnd_activation_public_controller_invalid' });
  assert.deepEqual(invalid.trace, ['verify']);
});

test('failed or changing public attach darkens controller and cannot be replayed', async () => {
  for (const options of [{ attachFails: true }, { attachChanges: true }]) {
    const f = await fixture(options);
    await assert.rejects(f.publish(), { code: 'nnd_activation_public_controller_invalid' });
    assert.equal(f.state.published, false);
    assert.deepEqual(f.trace, ['verify', 'published', 'attach']);
    await assert.rejects(f.publish(), { code: 'nnd_activation_public_controller_invalid' });
    assert.deepEqual(f.trace, ['verify', 'published', 'attach']);
  }
});
