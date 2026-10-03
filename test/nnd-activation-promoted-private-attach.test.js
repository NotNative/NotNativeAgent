// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ContractError } from '../src/ids.js';

async function harness() {
  const identity = { installation_id: 'nna_selected', data_id: 'data_selected' };
  const serviceLease = {}, registryLease = {};
  const options = { operationId: randomUUID(), stageOperationId: randomUUID(), generation: randomUUID() };
  const receipt = { state: 'private_ticket_recorded_unresolved', receipt_sha256: 'a'.repeat(64),
    registration_revision: 'b'.repeat(64), publication_sha256: 'c'.repeat(64) };
  const evidence = { operation_id: options.operationId, stage_operation_id: options.stageOperationId,
    generation: options.generation, registration_revision: receipt.registration_revision,
    publication_sha256: receipt.publication_sha256, ticket_receipt_sha256: receipt.receipt_sha256,
    native_state: 'ready' };
  const health = { registration_revision: receipt.registration_revision,
    journal_sha256: receipt.publication_sha256, native_state: 'ready' };
  const frame = { type: 'ui_ticket', protocol: '1.0', generation: options.generation,
    request_id: 'request', ticket: 'private-ticket', expires_at: Date.now() + 10000 };
  let reads = 0, commands = 0, redemptions = 0, changed = false, promoted = true;
  const state = { identity, lease: serviceLease, nativePrincipalPromoted: true,
    published: false, stopping: false, ui: 'http://127.0.0.1:12345', record: {},
    child: { failed: false, child: { exitCode: null }, command: async () => { commands++; return frame; } },
    controller: { isListening: () => true },
    native: { isListening: () => true, promotedPrincipalEvidence: () => promoted ? evidence : null } };
  const dependencies = { ContractError,
    withNndServiceLease: (_lease, _data, work) => work(new AbortController().signal),
    runManifestLeaseWork: (_lease, work) => work(), assertNndAttach: () => {},
    readNndPrivateTicketReceiptUnderOwnership: async () => {
      reads++; return changed && reads === 2 ? { ...receipt, receipt_sha256: 'd'.repeat(64) } : receipt;
    },
    verifyNndPublishedTrialHealthUnderOwnership: async () => health,
    redeemNndPrivateTicket: async () => { redemptions++; } };
  const source = await readFile(new URL('../src/nnd-activation-promoted-private-attach.js', import.meta.url), 'utf8');
  const executable = source.replace(/^import\s[\s\S]*?;\r?\n/gm, '')
    .replaceAll('export async function', 'async function');
  const run = Function(...Object.keys(dependencies), `${executable}\nreturn probeNndPromotedPrivateAttachUnderOwnership;`)
    (...Object.values(dependencies));
  return { run: () => run(identity, state, serviceLease, registryLease, options), options, receipt,
    get reads() { return reads; }, get commands() { return commands; }, get redemptions() { return redemptions; },
    changeReceipt: () => { changed = true; }, removePromotion: () => { promoted = false; } };
}

test('fresh post-promotion private attach yields unresolved evidence and burns its one attempt', async () => {
  const f = await harness();
  assert.deepEqual(await f.run(), { state: 'promoted_private_attach_verified_unresolved',
    operation_id: f.options.operationId, generation: f.options.generation,
    registration_revision: f.receipt.registration_revision,
    ticket_receipt_sha256: f.receipt.receipt_sha256, native_state: 'ready' });
  assert.equal(f.commands, 1); assert.equal(f.redemptions, 1); assert.equal(f.reads, 2);
  await assert.rejects(f.run(), { code: 'nnd_activation_transition_proof_invalid' });
  assert.equal(f.commands, 1);
});
test('receipt change after redemption and missing promotion fail closed', async () => {
  const changed = await harness(); changed.changeReceipt();
  await assert.rejects(changed.run(), { code: 'nnd_activation_transition_proof_invalid' });
  assert.equal(changed.commands, 1);
  const unpromoted = await harness(); unpromoted.removePromotion();
  await assert.rejects(unpromoted.run(), { code: 'nnd_activation_transition_proof_invalid' });
  assert.equal(unpromoted.commands, 0);
});
