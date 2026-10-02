// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { ContractError } from '../src/ids.js';
import { serializeManifestBytes } from '../src/persistence/manifest-files.js';
import { assertNoNndInstallTransaction, writeInstallNew as realWriteInstallNew } from '../src/nnd-install-storage.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value) + '\n');
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nnd-registration-test-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const operationId = randomUUID(), stageOperationId = randomUUID(), generation = randomUUID();
  const identity = { data_root: root, data_id: `data_${'b'.repeat(64)}`, installation_id: `nna_${'a'.repeat(64)}` };
  const lease = {}, registryLease = {};
  const previous = Buffer.from('{ "old": true }\r\n');
  let registryBytes = options.absent ? null : previous;
  const record = { root: join(root, 'immutable-slot'), version: options.badVersion ? 'version-invalid' : '20261002-18', protocol: '1.0' };
  const desired = serializeManifestBytes(record);
  const candidate = { package: record, evidence: { stage_operation_id: stageOperationId,
    installation_id: identity.installation_id, data_id: identity.data_id,
    registry_before_revision: registryBytes ? sha(registryBytes) : 'absent',
    desired_registration_sha256: sha(desired) } };
  candidate.evidence_sha256 = sha(json(candidate.evidence));
  const base = join(root, 'runtime', 'nnd'), activation = join(base, 'install-slots', 'activations');
  const marker = json({ protocol: '3.0', purpose: 'nnd_activation', operation_id: operationId,
    installation_id: identity.installation_id, data_id: identity.data_id, prepared_sha256: sha('prepared') });
  await mkdir(activation, { recursive: true }); await writeFile(join(base, 'installation-pending.json'), marker);
  const files = new Map([[join(base, 'installation-pending.json'), marker],
    [join(activation, `${operationId}.candidate.json`), json(candidate.evidence)]]);
  if (registryBytes) files.set(join(activation, `${operationId}.registration.before`), registryBytes);
  const journal = [{ phase: 'prepared', receipt_sha256: sha('prepared'), evidence_sha256: candidate.evidence_sha256 },
    { phase: 'trial_starting' }, { phase: 'trial_running' }, { phase: 'trial_healthy' }];
  const state = { record: { instance_id: generation }, package: { version: record.version }, stopping: false,
    child: { failed: false, child: { pid: 4321, exitCode: null } } };
  let captures = 0, writes = 0, casCalls = 0;
  const processIdentity = { version: 1, pid: 4321, platform: 'win32', start_id: '123456789' };
  const dependencies = { join, resolve, isAbsolute, ContractError, serializeManifestBytes, json, hash: sha,
    operationValid: value => value === operationId || value === stageOperationId,
    assertHeldNndServiceLease: actual => { if (actual !== lease) throw new ContractError('nnd_lock_lost','lost'); },
    withNndServiceLease: (_lease,_dataId,operation) => operation(new AbortController().signal),
    assertManifestLease: actual => { if (actual !== registryLease) throw new ContractError('manifest_lock_invalid','lost');
      return { path: join(root, 'config', 'nnd-package.json') }; },
    runManifestLeaseWork: (_lease,operation) => operation(),
    readNndActivationJournal: async () => journal,
    readNndPreparedActivationCandidate: async () => candidate,
    readInstallBytes: async (path,_limit,optional) => files.get(path) ?? (optional ? null : Promise.reject(new Error('missing'))),
    writeInstallNew: async (path,bytes) => { if (files.has(path)) throw new Error('exists');
      await realWriteInstallNew(path,bytes); files.set(path,bytes); writes++; },
    readLockedManifestSnapshot: async () => ({ rawBytes: registryBytes, revision: registryBytes ? sha(registryBytes) : 'absent' }),
    captureDiscoveryProcessIdentity: async () => { captures++; return options.changedChild && captures > 1
      ? { ...processIdentity, start_id: '987654321' } : processIdentity; },
    validIdentity: value => value?.version === 1 && value.pid === 4321,
    transactLockedManifest: async (_lease,input) => { casCalls++;
      assert.equal(input.expectedRevision, candidate.evidence.registry_before_revision);
      assert.deepEqual(input.transform(), record); input.validate(input.transform());
      registryBytes = desired;
      if (options.crashAfterCas) throw new Error('simulated parent death after CAS');
      return { persistence: 'saved', beforeRevision: candidate.evidence.registry_before_revision,
        persistedRevision: sha(desired) }; },
    appendNndActivationPhase: async (_identity,_directory,_lease,_registry,phase) => {
      assert.equal(phase,'registration_cas'); if (options.failJournal) throw new Error('journal write failed');
      journal.push({ phase }); return { receipt_sha256: sha('pointer-cas') }; } };
  const source = await readFile(new URL('../src/nnd-activation-registration.js', import.meta.url), 'utf8');
  const executable = source.replace(/^import\s[\s\S]*?;\r?\n/gm, '').replaceAll('export async function','async function');
  const run = Function(...Object.keys(dependencies), executable + '\nreturn selectNndTrialRegistrationUnderOwnership;')
    (...Object.values(dependencies));
  return { run: () => run(identity,state,lease,registryLease,{operationId,stageOperationId,generation}),
    identity, state, files, marker, previous, desired, journal, get registryBytes(){return registryBytes;},
    get casCalls(){return casCalls;}, get writes(){return writes;} };
}
test('forward CAS preserves exact prior bytes and records live child identity before selection', async t => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.state,'registration_selected_unresolved');
  assert.deepEqual(f.registryBytes,f.desired);
  assert.deepEqual(f.files.get(join(f.identity.data_root,'runtime','nnd','install-slots','activations',
    `${result.operation_id}.registration.before`)),f.previous);
  assert.equal(f.writes,1); assert.equal(f.journal.at(-1).phase,'registration_cas');
  const childPath=join(f.identity.data_root,'runtime','nnd','install-slots','activations',
    `${result.operation_id}.child.json`);
  assert.deepEqual(await readFile(childPath),f.files.get(childPath));
  assert.equal(JSON.parse(await readFile(childPath,'utf8')).process_identity.start_id,'123456789');
  assert.deepEqual(f.files.get(join(f.identity.data_root,'runtime','nnd','installation-pending.json')),f.marker);
  // The owning trial shuts down after the continuation; selected bytes alone
  // cannot admit an ordinary service start without terminal activation evidence.
  f.state.child.child.exitCode = 0;
  await assert.rejects(assertNoNndInstallTransaction(f.identity),{code:'nnd_install_transaction_pending'});
  await assert.rejects(f.run(),{code:'nnd_activation_registration_invalid'});
  assert.equal(f.casCalls,1);
});
test('changed prior bytes or changed child process start identity prevents CAS', async t => {
  const f = await fixture(t);
  // The prior-file key is recovered from the activation directory rather than a public path.
  const priorPath=[...f.files.keys()].find(path=>path.endsWith('.registration.before'));
  f.files.set(priorPath,Buffer.from('foreign'));
  await assert.rejects(f.run(),{code:'nnd_activation_registration_invalid'});
  assert.equal(f.casCalls,0);
  const child = await fixture(t,{changedChild:true});
  await assert.rejects(child.run(),{code:'nnd_activation_registration_invalid'});
  assert.equal(child.casCalls,0);
  const malformed = await fixture(t,{badVersion:true});
  await assert.rejects(malformed.run(),{code:'nnd_activation_registration_invalid'});
  assert.equal(malformed.casCalls,0);assert.equal(malformed.writes,0);
});
test('failure after CAS keeps barrier and exact prior bytes for native recovery', async t => {
  const f = await fixture(t,{crashAfterCas:true});
  await assert.rejects(f.run(),/simulated parent death/u);
  assert.deepEqual(f.registryBytes,f.desired);
  assert.equal(f.journal.at(-1).phase,'trial_healthy');
  const priorPath=[...f.files.keys()].find(path=>path.endsWith('.registration.before'));
  assert.deepEqual(f.files.get(priorPath),f.previous);
  await assert.rejects(assertNoNndInstallTransaction(f.identity),{code:'nnd_install_transaction_pending'});
});
test('journal failure after saved CAS remains unresolved behind admission barrier', async t => {
  const f = await fixture(t,{failJournal:true});
  await assert.rejects(f.run(),/journal write failed/u);
  assert.deepEqual(f.registryBytes,f.desired);
  assert.equal(f.journal.at(-1).phase,'trial_healthy');
  const priorPath=[...f.files.keys()].find(path=>path.endsWith('.registration.before'));
  assert.deepEqual(f.files.get(priorPath),f.previous);
  await assert.rejects(assertNoNndInstallTransaction(f.identity),{code:'nnd_install_transaction_pending'});
});
