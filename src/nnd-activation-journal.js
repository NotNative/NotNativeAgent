// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { ContractError } from './ids.js';
import { assertHeldNndServiceLease, withNndServiceLease } from './nnd-service-lock.js';
import { assertManifestLease, runManifestLeaseWork } from './persistence/manifest-lock.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const NAME = /^activation-(\d{2})\.json$/u;
const KEYS = ['protocol', 'operation_id', 'installation_id', 'data_id', 'sequence', 'phase', 'previous_sha256', 'evidence_sha256'];
const NEXT = Object.freeze({
  prepared: ['trial_starting', 'rollback_pending'],
  trial_starting: ['trial_running', 'rollback_pending'],
  trial_running: ['trial_healthy', 'rollback_pending'],
  trial_healthy: ['pointer_cas', 'rollback_pending'],
  pointer_cas: ['discovery_published', 'rollback_pending'],
  discovery_published: ['completed', 'rollback_pending'],
  completed: ['barrier_cleared'],
  rollback_pending: ['rollback_complete'],
  barrier_cleared: [], rollback_complete: [],
});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const invalid = () => new ContractError('nnd_activation_journal_invalid', 'NND activation evidence is incomplete or inconsistent; preserve the admission barrier.');
const fileName = index => `activation-${String(index).padStart(2, '0')}.json`;
export function nndPreparedPhaseBytes(identity, evidenceSha256) {
  if (!UUID.test(identity?.operation_id) || !/^nna_[a-f0-9]{64}$/u.test(identity?.installation_id)
    || !/^data_[a-f0-9]{64}$/u.test(identity?.data_id) || !SHA.test(evidenceSha256)) throw invalid();
  return Buffer.from(JSON.stringify({ protocol: '2.0', operation_id: identity.operation_id,
    installation_id: identity.installation_id, data_id: identity.data_id, sequence: 0,
    phase: 'prepared', previous_sha256: null, evidence_sha256: evidenceSha256 }) + '\n');
}
const samePath = (left, right) => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);

async function validateBinding(identity, directory, allowMissing = false) {
  if (!identity || !UUID.test(identity.operation_id) || !/^nna_[a-f0-9]{64}$/u.test(identity.installation_id)
    || !/^data_[a-f0-9]{64}$/u.test(identity.data_id) || typeof identity.data_root !== 'string'
    || !isAbsolute(identity.data_root) || !samePath(directory, join(identity.data_root, 'runtime', 'nnd', 'install-slots', 'activations', identity.operation_id))) throw invalid();
  let root;
  try { root = await realpath(identity.data_root); } catch { throw invalid(); }
  if (identity.data_id !== `data_${hash(root.toLowerCase())}` || !samePath(root, identity.data_root)) throw invalid();
  try {
    const actual = await realpath(directory);
    if (!samePath(actual, directory) || !(await lstat(actual)).isDirectory()) throw invalid();
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return;
    throw invalid();
  }
}
function validRecord(value, identity, index, previous) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === KEYS.length && KEYS.every(key => Object.hasOwn(value, key))
    && value.protocol === '2.0' && value.operation_id === identity.operation_id
    && value.installation_id === identity.installation_id && value.data_id === identity.data_id
    && value.sequence === index && typeof value.phase === 'string' && Object.hasOwn(NEXT, value.phase)
    && value.previous_sha256 === previous && SHA.test(value.evidence_sha256)
    && (index === 0 ? value.phase === 'prepared' : NEXT[identity.previous_phase]?.includes(value.phase));
}
async function boundedReceipt(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size < 1 || metadata.size > 2048) throw invalid();
  const file = await open(path, 'r');
  try {
    const observed = await file.stat();
    if (!observed.isFile() || observed.nlink !== 1 || observed.size !== metadata.size) throw invalid();
    const bytes = Buffer.alloc(observed.size);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== bytes.length) throw invalid();
    return bytes;
  } finally { await file.close(); }
}

// Security: this reader accepts only a bounded journal at the identity-bound private store path.
// It does not infer a missing publication from an absent phase receipt.
export async function readNndActivationJournal(identity, directory) {
  await validateBinding(identity, directory, true);
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return Object.freeze([]); throw invalid(); }
  // The operation directory belongs exclusively to this journal. A renamed receipt or
  // interrupted foreign write is evidence, never an empty journal to replay from scratch.
  if (entries.length > 10 || entries.some(entry => !entry.isFile() || !NAME.test(entry.name))) throw invalid();
  const names = entries;
  names.sort((left, right) => left.name.localeCompare(right.name));
  const records = []; let previous = null, previousPhase = null;
  for (let index = 0; index < names.length; index++) {
    if (names[index].name !== fileName(index)) throw invalid();
    let bytes, value;
    try {
      bytes = await boundedReceipt(join(directory, names[index].name));
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch { throw invalid(); }
    if (!validRecord(value, { ...identity, previous_phase: previousPhase }, index, previous)) throw invalid();
    previous = hash(bytes); previousPhase = value.phase;
    records.push(Object.freeze({ ...value, receipt_sha256: previous }));
  }
  return Object.freeze(records);
}

// Invariant: the owner holds both locks through the durable write. This receipt records a completed
// external step; callers must reconcile actual pointer/process evidence when the receipt is absent.
export async function appendNndActivationPhase(identity, directory, serviceLease, registryLease, phase, evidenceSha256) {
  await validateBinding(identity, directory);
  assertHeldNndServiceLease(serviceLease, identity.data_id);
  const target = assertManifestLease(registryLease);
  if (!samePath(target.path, join(identity.data_root, 'config', 'nnd-package.json')) || !SHA.test(evidenceSha256)) throw invalid();
  return withNndServiceLease(serviceLease, identity.data_id, signal => runManifestLeaseWork(registryLease, async () => {
    signal.throwIfAborted();
    const records = await readNndActivationJournal(identity, directory);
    const index = records.length, prior = records.at(-1);
    if (index >= 10 || !Object.hasOwn(NEXT, phase) || (index === 0 ? phase !== 'prepared' : !NEXT[prior.phase].includes(phase))) throw invalid();
    const record = { protocol: '2.0', operation_id: identity.operation_id, installation_id: identity.installation_id,
      data_id: identity.data_id, sequence: index, phase, previous_sha256: prior?.receipt_sha256 ?? null,
      evidence_sha256: evidenceSha256 };
    const bytes = index === 0 ? nndPreparedPhaseBytes(identity, evidenceSha256)
      : Buffer.from(JSON.stringify(record) + '\n');
    let file;
    try {
      file = await open(join(directory, fileName(index)), 'wx', 0o600);
      await file.writeFile(bytes); await file.sync();
    } catch { throw invalid(); }
    finally { await file?.close(); }
    const checked = await readNndActivationJournal(identity, directory);
    if (checked.length !== index + 1 || checked.at(-1).receipt_sha256 !== hash(bytes)) throw invalid();
    return checked.at(-1);
  }), { timeoutMs: 300000 });
}
