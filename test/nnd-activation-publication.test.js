// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ContractError } from '../src/ids.js';
import { serializeManifestBytes } from '../src/persistence/manifest-files.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value) + '\n');
async function fixture(t, options = {}) {
  const operationId = randomUUID(), stageOperationId = randomUUID(), generation = randomUUID();
  const identity = { data_root: 'C:\\nna-data', installation_id: `nna_${'a'.repeat(64)}`, data_id: `data_${'b'.repeat(64)}` };
  const lease = {}, registryLease = {}, version = '20261003-1';
  const packageRecord = { root: 'C:\\nna-data\\slot', version, protocol: '1.0' };
  const desired = serializeManifestBytes(packageRecord);
  const candidate = { stage_operation_id: options.wrongStage ? randomUUID() : stageOperationId, installation_id: identity.installation_id,
    data_id: identity.data_id, version, payload_sha256: hash('payload'), registry_before_revision: 'absent',
    desired_registration_sha256: hash(desired) };
  const childIdentity = { version: 1, pid: 4321, platform: 'win32', start_id: '123456789' };
  const parentIdentity = { version: 1, pid: 9876, platform: 'win32', start_id: '987654321' };
  const child = { protocol: '1.0', operation_id: operationId, installation_id: identity.installation_id,
    data_id: identity.data_id, generation, version, process_identity: childIdentity };
  const record = { version: '1.0', purpose: 'nnd_service_control', installation_id: identity.installation_id,
    data_id: identity.data_id, instance_id: generation, endpoint: 'http://127.0.0.1:1111',
    control_token: 'x'.repeat(43), process_identity: parentIdentity, created_at: '2026-10-03T00:00:00.000Z' };
  const state = { registrationSelected: true, published: false, stopping: false, package: packageRecord,
    record, controller: { endpoint: record.endpoint }, ui: 'http://127.0.0.1:2222',
    child: { failed: false, child: { pid: childIdentity.pid, exitCode: null } } };
  const activation = join(identity.data_root, 'runtime', 'nnd', 'install-slots', 'activations');
  const marker = { protocol: '3.0', purpose: 'nnd_activation', operation_id: operationId,
    installation_id: identity.installation_id, data_id: identity.data_id, prepared_sha256: hash('prepared') };
  const files = new Map([[join(identity.data_root, 'runtime', 'nnd', 'installation-pending.json'), json(marker)],
    [join(activation, `${operationId}.candidate.json`), json(candidate)],
    [join(activation, `${operationId}.child.json`), json(child)]]);
  const journal = [{ phase: 'prepared', receipt_sha256: marker.prepared_sha256,
    evidence_sha256: hash(json(candidate)) }, { evidence_sha256: hash(json({ operation_id: operationId,
      stage_operation_id: stageOperationId, installation_id: identity.installation_id,
      data_id: identity.data_id, version, payload_sha256: candidate.payload_sha256 })) },
    { evidence_sha256: hash(json({ installation_id: identity.installation_id, data_id: identity.data_id,
      generation, version })) }, {}, { phase: 'registration_cas', evidence_sha256: hash(json({
      operation_id: operationId, before_revision: 'absent', after_revision: hash(desired), child_sha256: hash(json(child)) })) }];
  let pointer = null, publications = 0, journalWrites = 0;
  const dependencies = { isDeepStrictEqual, join, resolve, ContractError, serializeManifestBytes, json, hash,
    exactRecord: (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)),
    operationValid: value => [operationId, stageOperationId, generation].includes(value),
    assertHeldNndServiceLease: value => { if (value !== lease) throw new Error('service lease'); },
    withNndServiceLease: (_lease, _dataId, fn) => fn(new AbortController().signal),
    assertManifestLease: value => { if (value !== registryLease) throw new Error('registry lease');
      return { path: join(identity.data_root, 'config', 'nnd-package.json') }; },
    runManifestLeaseWork: (_lease, fn) => fn(),
    readLockedManifestSnapshot: async () => ({ rawBytes: options.wrongRegistration ? Buffer.from('wrong') : desired }),
    readNndActivationJournal: async () => journal,
    appendNndActivationPhase: async (_id, _dir, _service, _registry, phase) => {
      assert.equal(phase, 'discovery_published'); journalWrites++; return { receipt_sha256: hash('published') }; },
    reconcileNndRegistrationUnderOwnership: async () => {
      if (options.changedMarkerAfterReconcile) files.set(join(identity.data_root, 'runtime', 'nnd', 'installation-pending.json'),
        json({ ...marker, extra: true }));
      if (options.changedChildAfterReconcile) files.set(join(activation, `${operationId}.child.json`),
        json({ ...child, extra: true }));
      if (options.changedRunningAfterReconcile) journal[2].evidence_sha256 = hash('foreign running');
      if (options.changedCasAfterReconcile) journal[4].evidence_sha256 = hash('foreign cas');
      return options.unselected ? { state: 'unknown', child_state: 'same_process' }
        : { state: 'selected_unresolved', child_state: 'same_process' };
    },
    readInstallBytes: async path => files.get(path) ?? null,
    readNndPrivateDiscoveryGeneration: async () => options.wrongPrivate ? { ...record, control_token: 'z'.repeat(43) } : record,
    readNndServiceDiscovery: async () => pointer,
    publishNndDiscoveryGeneration: async () => { publications++; pointer = options.foreignPointer ? { ...record, instance_id: randomUUID() } : record;
      if (options.throwAfterPublish) throw new Error('ambiguous'); },
    captureDiscoveryProcessIdentity: async (_signal, pid) => pid === childIdentity.pid
      ? options.changedChild ? { ...childIdentity, start_id: 'changed' } : childIdentity : parentIdentity,
    validIdentity: value => value?.version === 1 && value?.platform === 'win32',
  };
  const source = await readFile(new URL('../src/nnd-activation-publication.js', import.meta.url), 'utf8');
  const executable = source.replace(/^import\s[\s\S]*?;\r?\n/gm, '').replaceAll('export async function', 'async function');
  const run = Function(...Object.keys(dependencies), executable + '\nreturn publishNndSelectedDiscoveryUnderOwnership;')
    (...Object.values(dependencies));
  return { run: () => run(identity, state, lease, registryLease, { operationId, stageOperationId, generation }),
    state, files, candidate, child, record, get publications() { return publications; }, get journalWrites() { return journalWrites; } };
}

test('held publication confirms exact pointer and journals an unresolved phase', async t => {
  const f = await fixture(t), result = await f.run();
  assert.equal(result.state, 'discovery_published_unresolved');
  assert.equal(f.publications, 1); assert.equal(f.journalWrites, 1);
  assert.equal(f.state.published, false, 'controller must remain closed to attach');
});

test('ambiguous pointer write is reconciled only when exact selected record is visible', async t => {
  const recovered = await fixture(t, { throwAfterPublish: true });
  assert.equal((await recovered.run()).state, 'discovery_published_unresolved');
  const foreign = await fixture(t, { foreignPointer: true });
  await assert.rejects(foreign.run(), { code: 'nnd_activation_publication_invalid' });
  assert.equal(foreign.journalWrites, 0);
});

test('foreign stage, child change, registry mismatch and unselected CAS never publish', async t => {
  for (const options of [{ changedChild: true }, { wrongRegistration: true }, { unselected: true }, { wrongPrivate: true }]) {
    const f = await fixture(t, options);
    await assert.rejects(f.run(), { code: 'nnd_activation_publication_invalid' });
    assert.equal(f.publications, 0); assert.equal(f.journalWrites, 0);
  }
  const stage = await fixture(t, { wrongStage: true });
  await assert.rejects(stage.run(), { code: 'nnd_activation_publication_invalid' });
  assert.equal(stage.publications, 0);
});

test('evidence changed after registration reconciliation cannot publish a pointer', async t => {
  for (const options of [{ changedMarkerAfterReconcile: true }, { changedChildAfterReconcile: true },
    { changedRunningAfterReconcile: true }, { changedCasAfterReconcile: true }]) {
    const f = await fixture(t, options);
    await assert.rejects(f.run(), { code: 'nnd_activation_publication_invalid' });
    assert.equal(f.publications, 0);
    assert.equal(f.journalWrites, 0);
  }
});
