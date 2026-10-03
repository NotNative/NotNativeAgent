// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ContractError } from '../src/ids.js';
import { completionEvidenceSha } from '../src/nnd-activation-ticket-evidence.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const abort = new AbortController();
  const options = { operationId: randomUUID(), stageOperationId: randomUUID(),
    generation: randomUUID(), signal: abort.signal };
  const identity = { data_root: 'C:\\nna-completion-receipt', data_id: `data_${'a'.repeat(64)}`,
    installation_id: `nna_${'b'.repeat(64)}` };
  const serviceLease = {}, registryLease = {}, child = Buffer.from('owned child\n');
  const journal = Array.from({ length: 8 }, (_, index) => ({ phase: index === 7
    ? 'promoted_attach_verified' : 'earlier', receipt_sha256: hash(`receipt ${index}`) }));
  const ticket = { state: 'private_ticket_recorded_unresolved',
    receipt_sha256: journal[6].receipt_sha256, registration_revision: hash('registration') };
  const promoted = { state: 'promoted_attach_recorded_unresolved',
    receipt_sha256: journal[7].receipt_sha256, ticket_receipt_sha256: ticket.receipt_sha256 };
  const state = { identity, lease: serviceLease, retained: true, retainedLeaseArmed: true,
    stopping: false, published: false, child: { failed: false, child: { exitCode: null } },
    controller: { isListening: () => true }, native: { isListening: () => true },
    record: { instance_id: options.generation }, activationOperationId: options.operationId,
    stageOperationId: options.stageOperationId, promotedAttachReceipt: promoted };
  let appendCalls = 0, healthCalls = 0, damaged = false, abortAfterAppend = false,
    healthFails = false, exitAfterHealth = false;
  const dependencies = { join, resolve, ContractError, completionEvidenceSha, hash,
    operationValid: value => [options.operationId, options.stageOperationId, options.generation].includes(value),
    assertHeldNndServiceLease: lease => assert.equal(lease, serviceLease),
    withNndServiceLease: (_lease, _id, work) => work(new AbortController().signal),
    assertManifestLease: lease => { assert.equal(lease, registryLease);
      return { path: join(identity.data_root, 'config', 'nnd-package.json') }; },
    runManifestLeaseWork: (_lease, work) => work(),
    readNndActivationJournal: async () => {
      if (exitAfterHealth && healthCalls > 0 && appendCalls === 0) state.child.child.exitCode = 0;
      return journal;
    },
    readNndPromotedAttachReceiptUnderOwnership: async () => damaged
      ? { ...promoted, receipt_sha256: hash('foreign') } : promoted,
    readNndPrivateTicketReceiptUnderOwnership: async () => ticket,
    readInstallBytes: async () => child,
    verifyNndPublishedTrialHealthUnderOwnership: async () => {
      healthCalls++; if (healthFails) throw new Error('health failed');
      return { registration_revision: ticket.registration_revision, generation: options.generation };
    },
    appendNndActivationPhase: async (_identity, _directory, _service, _registry, phase, evidenceSha) => {
      appendCalls++; assert.equal(phase, 'completed');
      journal.push({ phase, evidence_sha256: evidenceSha, receipt_sha256: hash('completed receipt') });
      if (abortAfterAppend) abort.abort();
      return journal[8];
    } };
  const source = await readFile(new URL('../src/nnd-activation-completion-receipt.js', import.meta.url), 'utf8');
  const executable = source.replace(/^import\s[\s\S]*?;\r?\n/gm, '')
    .replaceAll('export async function', 'async function');
  const api = Function(...Object.keys(dependencies), `${executable}\nreturn {
    readNndCompletionReceiptUnderOwnership, recordNndCompletionUnderOwnership };`)(...Object.values(dependencies));
  return { observe: () => api.readNndCompletionReceiptUnderOwnership(identity, serviceLease, registryLease, options),
    record: () => api.recordNndCompletionUnderOwnership(identity, state, serviceLease, registryLease, options),
    journal, state, counters: () => ({ appendCalls, healthCalls }),
    damage: () => { damaged = true; }, abortAfterAppend: () => { abortAfterAppend = true; },
    failHealth: () => { healthFails = true; },
    exitAfterHealth: () => { exitAfterHealth = true; } };
}

test('completion records a private terminal decision while the owner and barrier remain', async () => {
  const f = await fixture();
  assert.equal((await f.observe()).state, 'unknown');
  const written = await f.record();
  assert.equal(written.state, 'completion_recorded_barred');
  assert.equal((await f.observe()).receipt_sha256, written.receipt_sha256);
  assert.deepEqual(f.counters(), { appendCalls: 1, healthCalls: 1 });
  await assert.rejects(f.record(), { code: 'nnd_activation_transition_proof_invalid' });
});
test('completion refuses an unarmed owner, failed health, and foreign predecessor', async () => {
  const f = await fixture();
  f.state.retainedLeaseArmed = false;
  await assert.rejects(f.record(), { code: 'nnd_activation_transition_proof_invalid' });
  assert.equal(f.counters().appendCalls, 0);
  const g = await fixture();
  g.failHealth();
  await assert.rejects(g.record(), { code: 'nnd_activation_transition_proof_invalid' });
  assert.equal(g.counters().appendCalls, 0);
  const h = await fixture();
  h.damage();
  await assert.rejects(h.record(), { code: 'nnd_activation_transition_proof_invalid' });
  assert.equal(h.counters().appendCalls, 0);
});
test('completion refuses a child that exits after health but before the durable append', async () => {
  const f = await fixture();
  f.exitAfterHealth();
  await assert.rejects(f.record(), { code: 'nnd_activation_transition_proof_invalid' });
  assert.deepEqual(f.counters(), { appendCalls: 0, healthCalls: 1 });
});
test('cancellation after append preserves a historical receipt without live success', async () => {
  const f = await fixture();
  f.abortAfterAppend();
  await assert.rejects(f.record(), { code: 'nnd_activation_transition_proof_invalid' });
  assert.equal(f.journal.at(-1).phase, 'completed');
  assert.equal((await f.observe()).state, 'completion_recorded_barred');
  f.journal[8].evidence_sha256 = hash('foreign evidence');
  await assert.rejects(f.observe(), { code: 'nnd_activation_transition_proof_invalid' });
});
