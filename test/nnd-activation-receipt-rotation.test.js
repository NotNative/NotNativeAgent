// SPDX-License-Identifier: Apache-2.0
// ADR 0069 rotation: only a consumed, canonical, identity- and revision-bound
// receipt pair may vacate the fixed evidence paths, and only whole into its
// archive under its own operation UUID. Half pairs, non-consumed pairs,
// revision drift, and archive collisions keep the bar with bytes untouched;
// a half-moved archive is repaired back to the fixed paths before anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, opendir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ContractError } from '../src/ids.js';
import { hash, readInstallBytes } from '../src/nnd-install-storage.js';
import { consumedRetirementPair } from '../src/nnd-activation-initialization-db.js';
import { hasActivationEvidence } from '../src/nnd-activation-initialization-db.js';

const INSTALL = 'nna_' + 'b'.repeat(64);
const DATA = 'data_' + 'a'.repeat(64);
const COMMIT_FILE = 'activation-retirement-commit.json';
const CLEARED_FILE = 'activation-retirement-cleared.json';

function commitFor(registrationRevision) {
  return { protocol: '1.0', state: 'terminal_committed_barred', operation_id: randomUUID(),
    stage_operation_id: randomUUID(), installation_id: INSTALL, data_id: DATA, generation: randomUUID(),
    plan_sha256: '1'.repeat(64), decision_sha256: '2'.repeat(64), completion_sha256: '3'.repeat(64),
    marker_sha256: '4'.repeat(64), registration_revision: registrationRevision, discovery_sha256: '6'.repeat(64),
    child_process_identity: { version: 1, start_id: '1', pid: process.pid, platform: 'win32' } };
}
function pairBytes(commit) {
  const bytes = Buffer.from ? Buffer.from(JSON.stringify(commit) + '\n') : null;
  const witness = { ...commit, state: 'barriers_cleared_admission_barred', terminal_sha256: hash(bytes) };
  return { commitBytes: bytes, witnessBytes: Buffer.from ? Buffer.from(JSON.stringify(witness) + '\n') : null };
}

async function fixture(t) {
  const root = await mkdtemp(join(homedir(), '.nnd-rot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  const slots = join(data, 'runtime', 'nnd', 'install-slots');
  await mkdir(join(data, 'config'), { recursive: true });
  await mkdir(slots, { recursive: true });
  const manifestBytes = Buffer.from(JSON.stringify({ root: 'C:/slot', version: '20261004-15',
    protocol: '1.0' }) + '\n');
  const pair = pairBytes(commitFor(hash(manifestBytes)));
  return { identity: { data_root: data, data_id: DATA, installation_id: INSTALL },
    slots, manifest: { revision: hash(manifestBytes), rawBytes: manifestBytes }, pair };
}
async function writePair(slots, pair) {
  await writeFile(join(slots, COMMIT_FILE), pair.commitBytes);
  await writeFile(join(slots, CLEARED_FILE), pair.witnessBytes);
}
async function apiFor(manifest, lease, signal = AbortSignal.timeout(30000)) {
  const source = await readFile(new URL('../src/nnd-activation-receipt-rotation.js', import.meta.url), 'utf8');
  const executable = source.replace(/^import[\s\S]*?;\r?\n/gmu, '')
    .replaceAll('export async function', 'async function');
  const dependencies = {
    lstat, opendir, rename, join, resolve, ContractError,
    assertHeldNndServiceLease: (held, dataId) => {
      if (held !== lease || dataId !== DATA) throw new Error('service lease');
    },
    withNndServiceLease: async (held, _dataId, work) => {
      if (held !== lease) throw new Error('service lease');
      return work(signal);
    },
    assertManifestLease: value => {
      if (!value?.path) throw new Error('registry lease');
      return value;
    },
    runManifestLeaseWork: async (_value, work) => work(),
    readLockedManifestSnapshot: async () => manifest,
    consumedRetirementPair,
    noLinks: async path => path,
    runPrivateWindowsProgram: async (_program, request) => {
      for (const directory of request?.directories ?? []) await mkdir(directory, { recursive: true });
      return { ok: true };
    },
    hash, readInstallBytes, PRIVATE_ACL_PROGRAM: '',
  };
  return Function(...Object.keys(dependencies),
    executable + '\nreturn { archiveConsumedRetirementReceiptUnderOwnership };')
    (...Object.values(dependencies));
}
async function rotate(f, lease) {
  const api = await apiFor(f.manifest, lease);
  return api.archiveConsumedRetirementReceiptUnderOwnership(f.identity, lease,
    { path: join(f.identity.data_root, 'config', 'nnd-package.json') });
}
const lease = { held: true };

test('no retirement evidence reports absent and writes nothing', async t => {
  const f = await fixture(t);
  assert.deepEqual(await rotate(f, lease), { rotated: false, state: 'absent' });
});

test('a consumed identity- and revision-bound pair moves whole into its archive', async t => {
  const f = await fixture(t);
  await writePair(f.slots, f.pair);
  assert.equal(await hasActivationEvidence(f.identity.data_root, f.identity), false);
  const result = await rotate(f, lease);
  assert.equal(result.state, 'consumed_receipt_archived');
  assert.equal(result.operation_id, JSON.parse(f.pair.commitBytes).operation_id);
  const archive = join(f.slots, 'consumed', result.operation_id);
  assert.deepEqual((await lstat(join(archive, COMMIT_FILE))).isFile(), true);
  assert.equal(hash(await readFile(join(archive, COMMIT_FILE))), hash(f.pair.commitBytes));
  assert.equal(hash(await readFile(join(archive, CLEARED_FILE))), hash(f.pair.witnessBytes));
  for (const name of [COMMIT_FILE, CLEARED_FILE]) {
    assert.equal((await lstat(join(f.slots, name)).catch(() => null)), null);
  }
});

test('half pairs, non-consumed pairs, and revision drift all keep the bar', async t => {
  const f = await fixture(t);
  await writeFile(join(f.slots, COMMIT_FILE), f.pair.commitBytes);
  await assert.rejects(rotate(f, lease), { code: 'nnd_activation_receipt_rotation_invalid' });
  // Half state untouched: the commit is still at the fixed path.
  assert.equal(hash(await readFile(join(f.slots, COMMIT_FILE))), hash(f.pair.commitBytes));
  // A full pair whose witness breaks the hash relation is not consumed.
  await writeFile(join(f.slots, CLEARED_FILE),
    Buffer.from(JSON.stringify({ ...JSON.parse(f.pair.witnessBytes), terminal_sha256: '9'.repeat(64) }) + '\n'));
  await assert.rejects(rotate(f, lease), { code: 'nnd_activation_receipt_rotation_invalid' });
  // A consumed pair bound to a different registration revision is refused.
  await writePair(f.slots, f.pair);
  const drifted = { ...f.manifest, revision: 'f'.repeat(64) };
  const api = await apiFor(drifted, lease);
  await assert.rejects(api.archiveConsumedRetirementReceiptUnderOwnership(f.identity, lease,
    { path: join(f.identity.data_root, 'config', 'nnd-package.json') }),
  { code: 'nnd_activation_receipt_rotation_invalid' });
  assert.equal(hash(await readFile(join(f.slots, COMMIT_FILE))), hash(f.pair.commitBytes));
});

test('a half-moved archive is restored before the pair is archived whole again', async t => {
  const f = await fixture(t);
  await writePair(f.slots, f.pair);
  const operation = JSON.parse(f.pair.commitBytes).operation_id;
  const archive = join(f.slots, 'consumed', operation);
  await mkdir(archive, { recursive: true });
  // Simulate a crash after only the cleared witness reached the archive.
  await rename(join(f.slots, CLEARED_FILE), join(archive, CLEARED_FILE));
  const result = await rotate(f, lease);
  assert.equal(result.state, 'consumed_receipt_archived');
  assert.equal(hash(await readFile(join(archive, CLEARED_FILE))), hash(f.pair.witnessBytes));
  assert.equal(hash(await readFile(join(archive, COMMIT_FILE))), hash(f.pair.commitBytes));
  for (const name of [COMMIT_FILE, CLEARED_FILE]) {
    assert.equal((await lstat(join(f.slots, name)).catch(() => null)), null);
  }
});

test('an occupied archive directory keeps the bar with the pair untouched', async t => {
  const f = await fixture(t);
  await writePair(f.slots, f.pair);
  const operation = JSON.parse(f.pair.commitBytes).operation_id;
  const archive = join(f.slots, 'consumed', operation);
  await mkdir(archive, { recursive: true });
  await writeFile(join(archive, 'stray.json'), 'x');
  await assert.rejects(rotate(f, lease), { code: 'nnd_activation_receipt_rotation_invalid' });
  assert.equal(hash(await readFile(join(f.slots, COMMIT_FILE))), hash(f.pair.commitBytes));
});

test('after uninstall removed the registration, the identity-bound pair still rotates', async t => {
  const f = await fixture(t);
  await writePair(f.slots, f.pair);
  // Guarded uninstall deletes nnd-package.json; the consumed pair stays.
  // readTargetSnapshot reports a missing manifest as a missing snapshot.
  const api = await apiFor({ path: 'nnd-package.json', state: 'missing', rawManifest: null,
    rawBytes: null, revision: 'absent' }, lease);
  const result = await api.archiveConsumedRetirementReceiptUnderOwnership(f.identity, lease,
    { path: join(f.identity.data_root, 'config', 'nnd-package.json') });
  assert.equal(result.state, 'consumed_receipt_archived');
  assert.equal((await lstat(join(f.slots, COMMIT_FILE)).catch(() => null)), null);
  assert.equal((await lstat(join(f.slots, CLEARED_FILE)).catch(() => null)), null);
});


