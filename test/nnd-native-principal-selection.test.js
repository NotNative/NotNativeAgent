// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ContractError } from '../src/ids.js';

async function selector(consume, gate, consumeTicket = () => { throw new Error('ticket unavailable'); }) {
  const source = await readFile(new URL('../src/nnd-native-principal-selection.js', import.meta.url), 'utf8');
  const executable = source.replace(/^import\s[\s\S]*?;\r?\n/gm, '').replace('export function', 'function');
  return Function('ContractError', 'assertNndTrialRequestAdmission', 'consumeNndPrincipalTransitionProof',
    'consumeNndHeldTicketConfirmation', executable + '\nreturn createNndNativePrincipalSelection;')
    (ContractError, gate, consume, consumeTicket);
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
test('ticket confirmation binds selected same-process evidence but does not open trial admission', async () => {
  const identity = {}, state = { native: { isListening: () => true }, controller: { isListening: () => true } };
  const selected = { operation_id: 'operation', stage_operation_id: 'stage', generation: 'generation',
    registration_revision: 'a'.repeat(64), journal_sha256: 'b'.repeat(64), native_state: 'ready' };
  const ticket = { operation_id: selected.operation_id, stage_operation_id: selected.stage_operation_id,
    generation: selected.generation, registration_revision: selected.registration_revision,
    publication_sha256: selected.journal_sha256, ticket_receipt_sha256: 'c'.repeat(64), native_state: 'ready' };
  let writesDenied = true, consumed = 0;
  const create = await selector(() => selected, (_gate, _identity, request) => {
    if (request.method !== 'GET' || !writesDenied) throw new Error('admission widened');
  }, () => { consumed++; return ticket; });
  const selection = create(identity, {}), lease = {}, registry = {}, options = {};
  selection.select(state.native, {}, state, lease, registry, options);
  assert.equal(selection.confirmedTicket(state.native, state), null);
  assert.equal(selection.confirmTicket(state.native, {}, state, lease, registry, options), ticket);
  assert.equal(selection.confirmedTicket(state.native, state), ticket);
  assert.equal(consumed, 1);
  assert.throws(() => selection.confirmTicket(state.native, {}, state, lease, registry, options),
    { code: 'nnd_activation_transition_proof_invalid' });
});
test('foreign ticket evidence cannot latch a principal confirmation', async () => {
  const identity = {}, state = { native: { isListening: () => true }, controller: { isListening: () => true } };
  const selected = { operation_id: 'operation', stage_operation_id: 'stage', generation: 'generation',
    registration_revision: 'a'.repeat(64), journal_sha256: 'b'.repeat(64), native_state: 'ready' };
  const create = await selector(() => selected, () => {}, () => ({ ...selected,
    publication_sha256: 'c'.repeat(64) }));
  const selection = create(identity, {}), lease = {}, registry = {};
  selection.select(state.native, {}, state, lease, registry, {});
  assert.throws(() => selection.confirmTicket(state.native, {}, state, lease, registry, {}),
    { code: 'nnd_activation_transition_proof_invalid' });
  assert.equal(selection.confirmedTicket(state.native, state), null);
});
test('ownership loss after ticket proof consumption cannot publish confirmed state', async () => {
  const identity = {}, state = { native: { isListening: () => true }, controller: { isListening: () => true } };
  const selected = { operation_id: 'operation', stage_operation_id: 'stage', generation: 'generation',
    registration_revision: 'a'.repeat(64), journal_sha256: 'b'.repeat(64), native_state: 'ready' };
  let calls = 0, loseAfterConsume = false;
  const create = await selector(() => selected, () => {
    calls++;
    if (loseAfterConsume && calls === 4) throw new ContractError('nnd_trial_admission_invalid', 'lease lost');
  }, () => ({ operation_id: selected.operation_id, stage_operation_id: selected.stage_operation_id,
    generation: selected.generation, registration_revision: selected.registration_revision,
    publication_sha256: selected.journal_sha256, native_state: selected.native_state }));
  const selection = create(identity, {}), lease = {}, registry = {};
  selection.select(state.native, {}, state, lease, registry, {});
  loseAfterConsume = true;
  assert.throws(() => selection.confirmTicket(state.native, {}, state, lease, registry, {}),
    { code: 'nnd_trial_admission_invalid' });
  assert.equal(selection.confirmedTicket(state.native, state), null);
});
test('closed controller cannot latch or expose stale held-live ticket evidence', async () => {
  const identity = {}; let controllerListening = true;
  const state = { native: { isListening: () => true }, controller: { isListening: () => controllerListening } };
  const selected = { operation_id: 'operation', stage_operation_id: 'stage', generation: 'generation',
    registration_revision: 'a'.repeat(64), journal_sha256: 'b'.repeat(64), native_state: 'ready' };
  const ticket = { operation_id: selected.operation_id, stage_operation_id: selected.stage_operation_id,
    generation: selected.generation, registration_revision: selected.registration_revision,
    publication_sha256: selected.journal_sha256, ticket_receipt_sha256: 'c'.repeat(64), native_state: 'ready' };
  const create = await selector(() => selected, () => {}, () => ticket);
  const before = create(identity, {}), lease = {}, registry = {}, options = {};
  before.select(state.native, {}, state, lease, registry, options);
  controllerListening = false;
  assert.throws(() => before.confirmTicket(state.native, {}, state, lease, registry, options),
    { code: 'nnd_activation_transition_proof_invalid' });
  assert.equal(before.confirmedTicket(state.native, state), null);
  controllerListening = true;
  const after = create(identity, {});
  after.select(state.native, {}, state, lease, registry, options);
  assert.equal(after.confirmTicket(state.native, {}, state, lease, registry, options), ticket);
  controllerListening = false;
  assert.equal(after.confirmedTicket(state.native, state), null);
});
