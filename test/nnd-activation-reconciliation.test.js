// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ContractError } from '../src/ids.js';
import { serializeManifestBytes } from '../src/persistence/manifest-files.js';
import { assertNoNndInstallTransaction } from '../src/nnd-install-storage.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value) + '\n');
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nnd-reconcile-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const operationId = randomUUID(), stageOperationId = randomUUID(), generation = randomUUID();
  const identity = { data_root: root, data_id: `data_${'b'.repeat(64)}`, installation_id: `nna_${'a'.repeat(64)}` };
  const serviceLease = {}, registryLease = {};
  let pointer = options.pointer ?? null;
  const base = join(root, 'runtime', 'nnd'), activation = join(base, 'install-slots', 'activations');
  await mkdir(activation, { recursive: true });
  const before = options.absent ? null : options.identical
    ? serializeManifestBytes({ root: join(base, 'install-slots', 'versions', '20261002-18-abc'), version: '20261002-18', protocol: '1.0' })
    : Buffer.from('{ "old": true }\r\n');
  const record = { root: join(base, 'install-slots', 'versions', '20261002-18-abc'), version: '20261002-18', protocol: '1.0' };
  const desired = serializeManifestBytes(record);
  let current = options.selected ? desired : before;
  const receipt = options.receipt === undefined ? options.selected
    ? { persistence: 'saved', beforeRevision: before ? hash(before) : 'absent', persistedRevision: hash(desired) }
    : null : options.receipt;
  const transactionBytes = Buffer.from('stage-transaction');
  const candidate = { protocol: '2.0', stage_operation_id: stageOperationId,
    installation_id: identity.installation_id, data_id: identity.data_id, version: record.version,
    payload_sha256: hash('payload'), stage_prepared_sha256: hash(transactionBytes),
    stage_ready_sha256: hash('ready'), provenance_sha256: hash('provenance'),
    slot_ino: '1', slot_dev: '2', registry_before_revision: before ? hash(before) : 'absent',
    desired_registration_sha256: hash(desired) };
  const child = { protocol: '1.0', operation_id: operationId,
    installation_id: identity.installation_id, data_id: identity.data_id,
    generation, version: record.version,
    process_identity: { version: 1, pid: 4321, platform: 'win32', start_id: '123456789' } };
  const journal = [{ phase: 'prepared', receipt_sha256: hash('prepared'), evidence_sha256: hash(json(candidate)) },
    { phase: 'trial_starting' },
    { phase: 'trial_running', evidence_sha256: hash(json({ installation_id: identity.installation_id,
      data_id: identity.data_id, generation, version: record.version })) },
    { phase: 'trial_healthy' }];
  if (options.journalSelected) journal.push({ phase: 'registration_cas', evidence_sha256: hash(json({
    operation_id: operationId, before_revision: candidate.registry_before_revision,
    after_revision: hash(desired), child_sha256: hash(json(child)) })) });
  const marker = json({ protocol: '3.0', purpose: 'nnd_activation', operation_id: operationId,
    installation_id: identity.installation_id, data_id: identity.data_id, prepared_sha256: journal[0].receipt_sha256 });
  const markerPath = join(base, 'installation-pending.json');
  await writeFile(markerPath, marker);
  const files = new Map([[markerPath, marker], [join(activation, `${operationId}.candidate.json`), json(candidate)]]);
  if (before) files.set(join(activation, `${operationId}.registration.before`), before);
  if (options.child !== false) files.set(join(activation, `${operationId}.child.json`), json(child));
  const dependencies = { join, resolve, ContractError, serializeManifestBytes, json, hash,
    operationValid: value => value === operationId || value === stageOperationId || value === generation,
    assertHeldNndServiceLease: lease => { if (lease !== serviceLease) throw new Error('forged lease'); },
    withNndServiceLease: (_lease, _id, work) => work(new AbortController().signal),
    assertManifestLease: lease => { if (lease !== registryLease) throw new Error('forged mutex');
      return { path: join(root, 'config', 'nnd-package.json') }; },
    runManifestLeaseWork: (_lease, work) => work(),
    readLockedManifestOperation: async () => receipt,
    readLockedManifestSnapshot: async () => ({ rawBytes: current }),
    loadInstallTransaction: async () => ({ record: { version: record.version, payload_sha256: candidate.payload_sha256 },
      bytes: transactionBytes, slot: record.root }),
    readNndActivationJournal: async () => journal,
    readNndServiceDiscovery: async () => pointer,
    readInstallBytes: async (path, _limit, optional) => files.get(path) ?? (optional ? null : Promise.reject(new Error('missing'))),
    captureDiscoveryProcessIdentity: async () => {
      if (options.probeUnavailable) throw new Error('probe unavailable');
      return options.reused ? { ...child.process_identity, start_id: '999999999' } : child.process_identity;
    },
    validIdentity: value => value?.version === 1 && Number.isSafeInteger(value.pid),
    exactRecord: (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) };
  const source = await readFile(new URL('../src/nnd-activation-reconciliation.js', import.meta.url), 'utf8');
  const executable = source.replace(/^import\s[\s\S]*?;\r?\n/gm, '').replace('export async function', 'async function');
  const run = Function(...Object.keys(dependencies), executable + '\nreturn reconcileNndRegistrationUnderOwnership;')
    (...Object.values(dependencies));
  return { run: () => run(identity, serviceLease, registryLease, { operationId }), files, candidate, child,
    journal, receipt, identity, marker, desired, before, operationId,
    setCurrent: bytes => { current = bytes; }, setPointer: value => { pointer = value; } };
}

test('crash before selection classifies exact prior bytes and retains barrier', async t => {
  const f = await fixture(t, { child: false });
  assert.deepEqual(await f.run(), { state: 'not_selected', operation_id: f.operationId, child_state: 'not_recorded' });
  await assert.rejects(assertNoNndInstallTransaction(f.identity), { code: 'nnd_install_transaction_pending' });
});
test('saved CAS without journal receipt remains selected but unresolved', async t => {
  const f = await fixture(t, { selected: true });
  assert.deepEqual(await f.run(), { state: 'selected_unresolved', operation_id: f.operationId, child_state: 'same_process' });
  assert.equal(f.journal.at(-1).phase, 'trial_healthy');
  await assert.rejects(assertNoNndInstallTransaction(f.identity), { code: 'nnd_install_transaction_pending' });
});
test('completed registration phase and reused PID leave outcome unknown', async t => {
  const f = await fixture(t, { selected: true, journalSelected: true, reused: true });
  assert.deepEqual(await f.run(), { state: 'unknown', operation_id: f.operationId });
});
test('absent prior registration and saved CAS remain distinguishable', async t => {
  const before = await fixture(t, { absent: true, child: false });
  assert.equal((await before.run()).state, 'not_selected');
  const after = await fixture(t, { absent: true, selected: true });
  assert.equal((await after.run()).state, 'selected_unresolved');
});
test('identical prior and desired bytes require a receipt to prove selection', async t => {
  const ambiguous = await fixture(t, { identical: true });
  assert.equal((await ambiguous.run()).state, 'unknown');
  const saved = await fixture(t, { identical: true, selected: true });
  assert.equal((await saved.run()).state, 'selected_unresolved');
});
test('foreign bytes, missing receipt, or inconsistent durable child evidence fail closed', async t => {
  const foreign = await fixture(t, { selected: true });
  foreign.setCurrent(Buffer.from('{"foreign":true}\n'));
  assert.equal((await foreign.run()).state, 'unknown');
  const lostReceipt = await fixture(t, { selected: true, receipt: null });
  assert.equal((await lostReceipt.run()).state, 'unknown');
  const lostBefore = await fixture(t, { receipt: null });
  assert.equal((await lostBefore.run()).state, 'unknown');
  const alteredChild = await fixture(t, { selected: true, journalSelected: true });
  const childPath = [...alteredChild.files.keys()].find(path => path.endsWith('.child.json'));
  alteredChild.files.set(childPath, json({ ...alteredChild.child, generation: randomUUID() }));
  assert.equal((await alteredChild.run()).state, 'unknown');
  const noChild = await fixture(t, { selected: true, child: false });
  assert.equal((await noChild.run()).state, 'unknown');
});
test('changed marker, public trial pointer, and unconfirmed child process preserve uncertainty', async t => {
  const marker = await fixture(t, { selected: true });
  const markerPath = [...marker.files.keys()].find(path => path.endsWith('installation-pending.json'));
  marker.files.set(markerPath, Buffer.from('changed\n'));
  assert.equal((await marker.run()).state, 'unknown');
  const pointer = await fixture(t, { selected: true });
  const pointerChild = JSON.parse([...pointer.files.entries()].find(([path]) => path.endsWith('.child.json'))[1]);
  pointer.setPointer({ instance_id: pointerChild.generation });
  assert.equal((await pointer.run()).state, 'unknown');
  const foreignBefore = await fixture(t, { child: false });
  foreignBefore.setPointer({ instance_id: randomUUID() });
  assert.equal((await foreignBefore.run()).state, 'unknown');
  const foreignAfter = await fixture(t, { selected: true });
  foreignAfter.setPointer({ instance_id: randomUUID() });
  assert.equal((await foreignAfter.run()).state, 'unknown');
  const unconfirmed = await fixture(t, { selected: true, probeUnavailable: true });
  assert.equal((await unconfirmed.run()).state, 'unknown');
});
