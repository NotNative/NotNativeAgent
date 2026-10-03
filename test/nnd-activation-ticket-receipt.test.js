// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ContractError } from '../src/ids.js';
import { privateTicketEvidenceSha, promotedAttachEvidenceSha } from '../src/nnd-activation-ticket-evidence.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value) + '\n');

async function fixture() {
  const operationId = randomUUID(), stageOperationId = randomUUID(), generation = randomUUID();
  const identity = { data_root: 'C:\\nna-receipt-test', installation_id: `nna_${'a'.repeat(64)}`,
    data_id: `data_${'b'.repeat(64)}` };
  const options = { operationId, stageOperationId, generation };
  const serviceLease = {}, registryLease = {};
  const child = { protocol: '1.0', operation_id: operationId, installation_id: identity.installation_id,
    data_id: identity.data_id, generation, version: '20261003-1',
    process_identity: { version: 1, pid: 100, platform: 'win32', start_id: '123' } };
  const childBytes = json(child), registration = json({ root: 'C:\\slot', version: child.version, protocol: '1.0' });
  const revision = hash(registration);
  const candidate = { package: { root: 'C:\\slot', version: child.version, protocol: '1.0' },
    evidence: { payload_sha256: hash('payload'), desired_registration_sha256: revision },
    evidence_sha256: hash('candidate') };
  const privateRecord = { installation_id: identity.installation_id, data_id: identity.data_id,
    instance_id: generation, endpoint: 'http://127.0.0.1:12345', control_token: 'secret' };
  let pointer = structuredClone(privateRecord);
  const journal = [{ phase: 'prepared', receipt_sha256: hash('prepared'), evidence_sha256: candidate.evidence_sha256 },
    { phase: 'trial_starting', evidence_sha256: hash(json({ operation_id: operationId,
      stage_operation_id: stageOperationId, installation_id: identity.installation_id,
      data_id: identity.data_id, version: child.version, payload_sha256: candidate.evidence.payload_sha256 })) },
    { phase: 'trial_running', evidence_sha256: hash(json({ installation_id: identity.installation_id,
      data_id: identity.data_id, generation, version: child.version })) }, { phase: 'trial_healthy' },
    { phase: 'registration_cas', evidence_sha256: hash(json({ operation_id: operationId,
      before_revision: 'absent', after_revision: revision, child_sha256: hash(childBytes) })) },
    { phase: 'discovery_published', receipt_sha256: hash('publication'),
      evidence_sha256: hash(json({ operation_id: operationId, registration_revision: revision,
        child_sha256: hash(childBytes), generation, discovery_sha256: hash(json(privateRecord)) })) },
    { phase: 'private_ticket_verified', receipt_sha256: hash('ticket receipt'),
      evidence_sha256: privateTicketEvidenceSha(identity, options, hash('publication'), revision, hash(childBytes)) }];
  const activation = join(identity.data_root, 'runtime', 'nnd', 'install-slots', 'activations');
  const marker = json({ protocol: '3.0', purpose: 'nnd_activation', operation_id: operationId,
    installation_id: identity.installation_id, data_id: identity.data_id,
    prepared_sha256: journal[0].receipt_sha256 });
  const files = new Map([[join(identity.data_root, 'runtime', 'nnd', 'installation-pending.json'), marker],
    [join(activation, `${operationId}.candidate.json`), json(candidate.evidence)],
    [join(activation, `${operationId}.child.json`), childBytes]]);
  const dependencies = { join, resolve, isDeepStrictEqual, ContractError, privateTicketEvidenceSha,
    promotedAttachEvidenceSha, hash, json,
    serializeManifestBytes: value => json(value),
    readNndSelectedActivationCandidate: async () => candidate,
    exactRecord: (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)),
    validIdentity: value => value?.version === 1 && Number.isSafeInteger(value.pid),
    operationValid: value => [operationId, stageOperationId, generation].includes(value),
    assertHeldNndServiceLease: lease => assert.equal(lease, serviceLease),
    withNndServiceLease: (_lease, _id, work) => work(new AbortController().signal),
    assertManifestLease: lease => { assert.equal(lease, registryLease);
      return { path: join(identity.data_root, 'config', 'nnd-package.json') }; },
    runManifestLeaseWork: (_lease, work) => work(),
    readNndActivationJournal: async () => journal,
    readInstallBytes: async path => files.get(path) ?? null,
    readLockedManifestOperation: async () => ({ operationId: `nnd-activate-${operationId}`,
      persistence: 'saved', beforeRevision: 'absent', persistedRevision: revision }),
    readLockedManifestSnapshot: async () => ({ rawBytes: registration, revision }),
    readNndServiceDiscovery: async () => pointer,
    readNndPrivateDiscoveryGeneration: async () => privateRecord };
  const source = await readFile(new URL('../src/nnd-activation-ticket-receipt.js', import.meta.url), 'utf8');
  const executable = source.replace(/^import\s[\s\S]*?;\r?\n/gm, '')
    .replaceAll('export async function', 'async function');
  const observe = Function(...Object.keys(dependencies),
    `${executable}\nreturn readNndPrivateTicketReceiptUnderOwnership;`)(...Object.values(dependencies));
  return { observe: () => observe(identity, serviceLease, registryLease, options), journal, files,
    candidate, options, childBytes, revision,
    setPointer: value => { pointer = value; }, identity, operationId };
}

test('durable private ticket receipt reopens as unresolved evidence only', async () => {
  const f = await fixture();
  assert.equal((await f.observe()).state, 'private_ticket_recorded_unresolved');
  f.journal[6].evidence_sha256 = hash('foreign proof');
  await assert.rejects(f.observe(), { code: 'nnd_activation_health_invalid' });
});
test('ticket observer validates a later promoted attach receipt without claiming completion', async () => {
  const f = await fixture();
  f.journal.push({ phase: 'promoted_attach_verified', receipt_sha256: hash('promoted receipt'),
    evidence_sha256: promotedAttachEvidenceSha(f.identity, f.options,
      f.journal[6].receipt_sha256, f.revision, hash(f.childBytes)) });
  assert.equal((await f.observe()).state, 'private_ticket_recorded_unresolved');
  f.journal[7].evidence_sha256 = hash('foreign promoted evidence');
  await assert.rejects(f.observe(), { code: 'nnd_activation_health_invalid' });
});
test('foreign selected pointer and missing marker cannot recover a private ticket receipt', async () => {
  const f = await fixture();
  f.setPointer({ installation_id: f.identity.installation_id, data_id: f.identity.data_id,
    instance_id: randomUUID() });
  assert.equal((await f.observe()).state, 'unknown');
  f.setPointer(null);
  f.files.clear();
  await assert.rejects(f.observe(), { code: 'nnd_activation_health_invalid' });
});
test('ticket receipt cannot classify with damaged staged provenance or earlier activation evidence', async () => {
  const f = await fixture();
  f.candidate.evidence_sha256 = hash('foreign candidate');
  await assert.rejects(f.observe(), { code: 'nnd_activation_health_invalid' });
  f.candidate.evidence_sha256 = f.journal[0].evidence_sha256;
  f.journal[4].evidence_sha256 = hash('foreign registration CAS');
  await assert.rejects(f.observe(), { code: 'nnd_activation_health_invalid' });
});
