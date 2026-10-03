// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ContractError } from '../src/ids.js';
import { promotedAttachEvidenceSha } from '../src/nnd-activation-ticket-evidence.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const controller = new AbortController();
  const options = { operationId: randomUUID(), stageOperationId: randomUUID(), generation: randomUUID(), signal: controller.signal };
  const identity = { data_root: 'C:\\nna-promoted-receipt', data_id: `data_${'a'.repeat(64)}`,
    installation_id: `nna_${'b'.repeat(64)}` };
  const serviceLease = {}, registryLease = {}, child = Buffer.from('owned child\n');
  const state = { identity, lease: serviceLease, record: { instance_id: options.generation } };
  const journal = Array.from({ length: 7 }, (_, index) => ({ phase: index === 6
    ? 'private_ticket_verified' : 'earlier', receipt_sha256: hash(`receipt ${index}`) }));
  const ticket = { state: 'private_ticket_recorded_unresolved', receipt_sha256: journal[6].receipt_sha256,
    registration_revision: hash('registration') };
  let probeCalls = 0, appendCalls = 0, changed = false, failAfterAppend = false, abortAfterAppend = false;
  const dependencies = { join, resolve, ContractError, promotedAttachEvidenceSha, hash,
    operationValid: value => Object.values(options).includes(value),
    assertHeldNndServiceLease: lease => assert.equal(lease, serviceLease),
    withNndServiceLease: (_lease, _id, work) => work(new AbortController().signal),
    assertManifestLease: lease => { assert.equal(lease, registryLease);
      return { path: join(identity.data_root, 'config', 'nnd-package.json') }; },
    runManifestLeaseWork: (_lease, work) => work(),
    readNndActivationJournal: async () => journal,
    readNndPrivateTicketReceiptUnderOwnership: async () => {
      if (failAfterAppend && journal.length === 8) throw new Error('owner died');
      return changed ? { ...ticket, receipt_sha256: hash('foreign ticket') } : ticket;
    },
    readInstallBytes: async () => child,
    probeNndPromotedPrivateAttachUnderOwnership: async () => {
      probeCalls++;
      return { state: 'promoted_private_attach_verified_unresolved', operation_id: options.operationId,
        generation: options.generation, registration_revision: ticket.registration_revision,
        ticket_receipt_sha256: ticket.receipt_sha256 };
    },
    appendNndActivationPhase: async (_identity, _dir, _service, _registry, phase, evidenceSha) => {
      appendCalls++; assert.equal(phase, 'promoted_attach_verified');
      journal.push({ phase, evidence_sha256: evidenceSha, receipt_sha256: hash('promoted receipt') });
      if (abortAfterAppend) controller.abort();
      return journal[7];
    } };
  const source = await readFile(new URL('../src/nnd-activation-promoted-attach-receipt.js', import.meta.url), 'utf8');
  const executable = source.replace(/^import\s[\s\S]*?;\r?\n/gm, '')
    .replaceAll('export async function', 'async function');
  const api = Function(...Object.keys(dependencies), `${executable}\nreturn {
    readNndPromotedAttachReceiptUnderOwnership, recordNndPromotedAttachUnderOwnership };`)(...Object.values(dependencies));
  return { observe: () => api.readNndPromotedAttachReceiptUnderOwnership(identity, serviceLease, registryLease, options),
    record: () => api.recordNndPromotedAttachUnderOwnership(identity, state, serviceLease, registryLease, options),
    journal, ticket, state, counters: () => ({ probeCalls, appendCalls }),
    changeTicket: () => { changed = true; }, failAfterAppend: () => { failAfterAppend = true; },
    abortAfterAppend: () => { abortAfterAppend = true; } };
}

test('private promoted attach appends once and crash observer reports historical unresolved evidence', async () => {
  const f = await fixture();
  assert.equal((await f.observe()).state, 'unknown');
  const written = await f.record();
  assert.equal(written.state, 'promoted_attach_recorded_unresolved');
  assert.equal((await f.observe()).receipt_sha256, written.receipt_sha256);
  f.journal.push({ phase: 'completed', receipt_sha256: hash('completion receipt'),
    evidence_sha256: hash('completion decision') });
  assert.equal((await f.observe()).receipt_sha256, written.receipt_sha256);
  assert.deepEqual(f.counters(), { probeCalls: 1, appendCalls: 1 });
  await assert.rejects(f.record(), { code: 'nnd_activation_transition_proof_invalid' });
  assert.deepEqual(f.counters(), { probeCalls: 1, appendCalls: 1 });
});
test('foreign ticket, damaged receipt, and unknown post-append outcome never become completion', async () => {
  const f = await fixture();
  f.changeTicket();
  await assert.rejects(f.record(), { code: 'nnd_activation_transition_proof_invalid' });
  assert.deepEqual(f.counters(), { probeCalls: 0, appendCalls: 0 });
  const g = await fixture();
  g.failAfterAppend();
  await assert.rejects(g.record(), { code: 'nnd_activation_transition_proof_invalid' });
  assert.equal(g.journal.at(-1).phase, 'promoted_attach_verified');
  await assert.rejects(g.observe());
  const h = await fixture();
  await h.record();
  h.journal[7].evidence_sha256 = hash('foreign evidence');
  await assert.rejects(h.observe(), { code: 'nnd_activation_transition_proof_invalid' });
});
test('cancellation during append retains historical evidence but refuses a successful live return', async () => {
  const f = await fixture();
  f.abortAfterAppend();
  await assert.rejects(f.record(), { code: 'nnd_activation_transition_proof_invalid' });
  assert.equal(f.journal.at(-1).phase, 'promoted_attach_verified');
  assert.equal((await f.observe()).state, 'promoted_attach_recorded_unresolved');
});
