// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ContractError } from '../src/ids.js';

async function harness() {
  const identity = {}, state = { native: {} }, serviceLease = {}, registryLease = {};
  const options = { operationId: randomUUID(), stageOperationId: randomUUID(), generation: randomUUID() };
  const receipt = { state: 'private_ticket_recorded_unresolved', operation_id: options.operationId,
    generation: options.generation, receipt_sha256: 'a'.repeat(64),
    publication_sha256: 'b'.repeat(64), registration_revision: 'c'.repeat(64) };
  const health = { state: 'published_healthy_unresolved', operation_id: options.operationId,
    generation: options.generation, registration_revision: receipt.registration_revision,
    journal_sha256: receipt.publication_sha256, native_state: 'ready' };
  let readCount = 0, consumeCount = 0, changed = false, failed = false, foreignProof = false;
  const dependencies = { ContractError,
    readNndPrivateTicketReceiptUnderOwnership: async () => {
      readCount++;
      return changed && readCount === 2 ? { ...receipt, receipt_sha256: 'd'.repeat(64) } : receipt;
    },
    verifyNndPublishedTrialHealthUnderOwnership: async (_i, _s, _l, _r, input) => {
      if (failed) throw new Error('child lost');
      input.afterVerified({ proof: {}, health }); return health;
    },
    consumeNndPrincipalTransitionProof: (_proof, i, s, l, r, given) => {
      assert.equal(i, identity); assert.equal(s, state); assert.equal(l, serviceLease);
      assert.equal(r, registryLease); assert.equal(given, options);
      consumeCount++;
      return { registration_revision: foreignProof ? 'e'.repeat(64) : health.registration_revision,
        journal_sha256: health.journal_sha256 };
    } };
  const source = await readFile(new URL('../src/nnd-activation-held-ticket.js', import.meta.url), 'utf8');
  const executable = source.replace(/^import\s[\s\S]*?;\r?\n/gm, '')
    .replaceAll('export async function', 'async function').replaceAll('export function', 'function');
  const functions = Function(...Object.keys(dependencies), `${executable}\nreturn {
    verify: verifyNndHeldTicketUnderOwnership, consume: consumeNndHeldTicketConfirmation };`)
    (...Object.values(dependencies));
  let usedProof;
  state.native.confirmHeldTicket = (proof, selected, lease, registry, given) => {
    usedProof = proof;
    return functions.consume(proof, identity, selected, lease, registry, given);
  };
  return { run: () => functions.verify(identity, state, serviceLease, registryLease, options), receipt,
    replay: () => functions.consume(usedProof, identity, state, serviceLease, registryLease, options),
    forge: () => functions.consume(Object.freeze({}), identity, state, serviceLease, registryLease, options),
    get reads() { return readCount; }, get consumes() { return consumeCount; },
    changeReceipt: () => { changed = true; }, failHealth: () => { failed = true; },
    foreignProof: () => { foreignProof = true; } };
}

test('held-live bridge binds receipt to one consumed live principal proof without promoting', async () => {
  const f = await harness();
  assert.deepEqual(await f.run(), { state: 'held_private_ticket_verified_unresolved',
    operation_id: f.receipt.operation_id, generation: f.receipt.generation,
    registration_revision: f.receipt.registration_revision,
    publication_sha256: f.receipt.publication_sha256,
    ticket_receipt_sha256: f.receipt.receipt_sha256, native_state: 'ready' });
  assert.equal(f.reads, 2); assert.equal(f.consumes, 1);
  assert.throws(f.replay, { code: 'nnd_activation_transition_proof_invalid' });
  assert.throws(f.forge, { code: 'nnd_activation_transition_proof_invalid' });
});
test('changed receipt after live proof or failed health cannot yield a transition', async () => {
  const changed = await harness(); changed.changeReceipt();
  await assert.rejects(changed.run(), { code: 'nnd_activation_transition_proof_invalid' });
  const failed = await harness(); failed.failHealth();
  await assert.rejects(failed.run(), { code: 'nnd_activation_transition_proof_invalid' });
  assert.equal(failed.consumes, 0);
  const foreign = await harness(); foreign.foreignProof();
  await assert.rejects(foreign.run(), { code: 'nnd_activation_transition_proof_invalid' });
});
