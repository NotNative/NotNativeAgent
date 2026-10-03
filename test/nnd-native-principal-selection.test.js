// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ContractError } from '../src/ids.js';

async function selector(consume, gate) {
  const source = await readFile(new URL('../src/nnd-native-principal-selection.js', import.meta.url), 'utf8');
  const executable = source.replace(/^import\s[\s\S]*?;\r?\n/gm, '').replace('export function', 'function');
  return Function('ContractError', 'assertNndTrialRequestAdmission', 'consumeNndPrincipalTransitionProof',
    executable + '\nreturn createNndNativePrincipalSelection;')(ContractError, gate, consume);
}

test('same-process principal selection consumes one proof but keeps native writes closed', async () => {
  const identity = { installation_id: 'nna_selected', data_id: 'data_selected' };
  const proof = Object.freeze({}); const serviceLease = {}, registryLease = {};
  let consumed = 0, admitted = 0, held = true, listening = true;
  const create = await selector((value, selected, state, service, registry, options) => {
    assert.equal(value, proof); assert.equal(selected, identity); assert.equal(state.native, native);
    assert.equal(service, serviceLease); assert.equal(registry, registryLease);
    assert.equal(options.generation, 'generation'); consumed++;
    return Object.freeze({ generation: 'generation', state: 'published_healthy_unresolved' });
  }, (_gate, selected, request) => {
    if (!held) throw new ContractError('nnd_trial_admission_invalid', 'lease lost');
    assert.equal(selected, identity); assert.equal(request.method, 'GET'); admitted++;
  });
  const selection = create(identity, {});
  const native = { isListening: () => listening };
  const state = { native }; const options = { generation: 'generation' };
  assert.equal(selection.evidence(native, state), null);
  const evidence = selection.select(native, proof, state, serviceLease, registryLease, options);
  assert.equal(evidence.generation, 'generation'); assert.equal(consumed, 1); assert.equal(admitted, 2);
  assert.equal(selection.evidence(native, state), evidence);
  assert.equal(admitted, 3);
  assert.equal(selection.evidence(native, { native }), null);
  assert.equal(selection.evidence({}, state), null);
  listening = false;
  assert.equal(selection.evidence(native, state), null);
  listening = true; held = false;
  assert.throws(() => selection.evidence(native, state), { code: 'nnd_trial_admission_invalid' });
  assert.throws(() => selection.select(native, proof, state, serviceLease, registryLease, options),
    { code: 'nnd_activation_transition_proof_invalid' });
});

test('foreign native, lost gate and rejected proof cannot select authority', async () => {
  const identity = {}; const native = { isListening: () => true }, state = { native };
  const rejected = await selector(() => { throw new ContractError('nnd_activation_transition_proof_invalid', 'expired'); }, () => {});
  const selection = rejected(identity, {});
  assert.throws(() => selection.select({}, {}, state, {}, {}, {}), { code: 'nnd_activation_transition_proof_invalid' });
  assert.throws(() => selection.select(native, {}, state, {}, {}, {}), { code: 'nnd_activation_transition_proof_invalid' });
  assert.equal(selection.evidence(native, state), null);
  const closed = await selector(() => { throw Error('must not consume'); }, () => { throw Error('lease lost'); });
  assert.throws(() => closed(identity, {}).select(native, {}, state, {}, {}, {}), /lease lost/u);
});
