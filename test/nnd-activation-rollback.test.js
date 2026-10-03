// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ContractError } from '../src/ids.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value) + '\n');
async function fixture(options = {}) {
  const operationId = randomUUID(), stageOperationId = randomUUID(), generation = randomUUID();
  const identity = { data_root: 'C:\\nna-rollback-test', data_id: `data_${'b'.repeat(64)}`,
    installation_id: `nna_${'a'.repeat(64)}` };
  const serviceLease = {}, registryLease = {}, proof = Object.freeze({});
  const before = options.absent ? null : Buffer.from('{"prior": true}\r\n');
  const beforeRevision = before === null ? 'absent' : hash(before);
  const desired = Buffer.from('{"protocol":"1.0","root":"C:\\\\slot","version":"20261002-1"}\n');
  const desiredRevision = hash(desired);
  const child = { protocol: '1.0', operation_id: operationId, installation_id: identity.installation_id,
    data_id: identity.data_id, generation, version: '20261002-1',
    process_identity: { version: 1, pid: 4321, platform: 'win32', start_id: '123456789' } };
  const childBytes = json(child);
  const candidate = { package: { version: child.version }, evidence: { desired_registration_sha256: desiredRevision,
    registry_before_revision: beforeRevision }, evidence_sha256: hash('candidate') };
  const base = join(identity.data_root, 'runtime', 'nnd'), activation = join(base, 'install-slots', 'activations');
  const marker = json({ protocol: '3.0', purpose: 'nnd_activation', operation_id: operationId,
    installation_id: identity.installation_id, data_id: identity.data_id, prepared_sha256: hash('prepared') });
  const files = new Map([[join(base, 'installation-pending.json'), marker],
    [join(activation, `${operationId}.candidate.json`), json(candidate.evidence)],
    [join(activation, `${operationId}.child.json`), childBytes]]);
  if (before !== null) files.set(join(activation, `${operationId}.registration.before`), before);
  const journal = [{ phase: 'prepared', receipt_sha256: hash('prepared'), evidence_sha256: candidate.evidence_sha256 },
    { phase: 'trial_starting' }, { phase: 'trial_running', evidence_sha256: hash(json({ installation_id: identity.installation_id,
      data_id: identity.data_id, generation, version: child.version })) }, { phase: 'trial_healthy', receipt_sha256: hash('healthy') }];
  if (options.forwardJournal !== false) journal.push({ phase: 'registration_cas',
    evidence_sha256: hash(json({ operation_id: operationId, before_revision: beforeRevision,
      after_revision: desiredRevision, child_sha256: hash(childBytes) })), receipt_sha256: hash('forward') });
  let current = desired, casCalls = 0, consumed = 0, pointer = null;
  const forward = { persistence: 'saved', beforeRevision, persistedRevision: desiredRevision };
  let rollbackReceipt = null;
  const dependencies = { join, resolve, ContractError, hash, json,
    operationValid: value => [operationId, stageOperationId, generation].includes(value),
    assertHeldNndServiceLease: lease => { if (lease !== serviceLease) throw Error('wrong lease'); },
    withNndServiceLease: (_lease,_id,fn) => fn(new AbortController().signal),
    assertManifestLease: lease => { if (lease !== registryLease) throw Error('wrong mutex');
      return { path: join(identity.data_root, 'config', 'nnd-package.json') }; },
    runManifestLeaseWork: (_lease,fn) => fn(),
    consumeNndStoppedTrialProof: (token,_identity,_service,_registry,provided) => {
      if (token !== proof || provided.operationId !== operationId || ++consumed !== 1) throw Error('invalid proof');
      return { child_identity: { pid: 4321, start_id: '123456789', sha256: hash(childBytes) },
        signal: new AbortController().signal }; },
    readNndActivationJournal: async () => journal,
    appendNndActivationPhase: async (_identity,_directory,_service,_registry,phase,evidenceSha) => {
      const item = { phase, evidence_sha256: evidenceSha, receipt_sha256: hash(phase) };
      journal.push(item); return item; },
    readInstallBytes: async (path) => files.get(path) ?? null,
    readNndSelectedActivationCandidate: async (_identity,_service,_registry,stage,seenMarker,revision) => {
      assert.equal(stage, stageOperationId); assert.deepEqual(seenMarker,marker); assert.equal(revision,beforeRevision);
      return candidate; },
    exactRecord: (value,keys) => value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key)),
    readNndServiceDiscovery: async () => pointer,
    readLockedManifestSnapshot: async () => ({ rawBytes: current, revision: current === null ? 'absent' : hash(current) }),
    readLockedManifestOperation: async (_lease,id) => id === `nnd-activate-${operationId}` ? forward : rollbackReceipt,
    transactLockedManifestBytes: async (_lease,input) => { casCalls++;
      assert.equal(input.operationId,`nnd-rollback-${operationId}`);
      assert.equal(input.expectedRevision,desiredRevision);
      assert.deepEqual(input.bytes,before);
      current = input.bytes;
      if (options.unknown) throw Object.assign(new Error('unknown'),{ code:'manifest_publication_unknown' });
      rollbackReceipt = { persistence:'saved', beforeRevision: desiredRevision, persistedRevision: beforeRevision };
      return rollbackReceipt; } };
  const source = await readFile(new URL('../src/nnd-activation-rollback.js', import.meta.url), 'utf8');
  const executable = source.replace(/^import\s[\s\S]*?;\r?\n/gm, '').replaceAll('export async function','async function');
  const run = Function(...Object.keys(dependencies), executable + '\nreturn rollbackNndTrialRegistrationAfterStop;')
    (...Object.values(dependencies));
  return { run: () => run(identity,serviceLease,registryLease,proof,{operationId,stageOperationId,generation}),
    files,journal,forward,childBytes,desired, marker, get current(){return current;},
    get casCalls(){return casCalls;}, set pointer(value){pointer=value;} };
}
for (const absent of [false,true]) test(`post-stop rollback restores exact ${absent ? 'absence' : 'malformed CRLF bytes'} and retains barrier`, async () => {
  const f = await fixture({absent});
  const result = await f.run();
  assert.equal(result.state,'registration_rolled_back_barrier_held');
  assert.deepEqual(f.current, absent ? null : Buffer.from('{"prior": true}\r\n'));
  assert.deepEqual(f.journal.slice(-2).map(item => item.phase),['rollback_pending','rollback_complete']);
  assert.deepEqual(f.files.get(join('C:\\nna-rollback-test','runtime','nnd','installation-pending.json')),f.marker);
  assert.equal(f.casCalls,1);
});
test('foreign evidence or discovery pointer refuses to mutate the selected manifest', async () => {
  const child = await fixture();
  const path=[...child.files.keys()].find(key=>key.endsWith('.child.json'));
  child.files.set(path,json({ ...JSON.parse(child.childBytes), generation: randomUUID() }));
  await assert.rejects(child.run(),{code:'nnd_activation_rollback_invalid'});
  assert.equal(child.casCalls,0);
  const pointer=await fixture();pointer.pointer={instance_id:randomUUID()};
  await assert.rejects(pointer.run(),{code:'nnd_activation_rollback_invalid'});
  assert.equal(pointer.casCalls,0);
  const changedCandidate=await fixture();
  const candidatePath=[...changedCandidate.files.keys()].find(key=>key.endsWith('.candidate.json'));
  changedCandidate.files.set(candidatePath,json({ desired_registration_sha256: hash('foreign') }));
  await assert.rejects(changedCandidate.run(),{code:'nnd_activation_rollback_invalid'});
  assert.equal(changedCandidate.casCalls,0);
  const changedReceipt=await fixture();changedReceipt.forward.beforeRevision=hash('foreign');
  await assert.rejects(changedReceipt.run(),{code:'nnd_activation_rollback_invalid'});
  assert.equal(changedReceipt.casCalls,0);
});
test('uncertain raw publication retains rollback_pending and the admission barrier', async () => {
  const f=await fixture({unknown:true});
  await assert.rejects(f.run(),{code:'manifest_publication_unknown'});
  assert.deepEqual(f.current, Buffer.from('{"prior": true}\r\n'));
  assert.equal(f.journal.at(-1).phase,'rollback_pending');
  assert.deepEqual(f.files.get(join('C:\\nna-rollback-test','runtime','nnd','installation-pending.json')),f.marker);
});
