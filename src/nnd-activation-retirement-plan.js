// SPDX-License-Identifier: Apache-2.0
/** Durable intent for terminal activation cleanup. This module never clears admission. */
import { lstat, opendir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ContractError } from './ids.js';
import { assertHeldNndServiceLease, withNndServiceLease } from './nnd-service-lock.js';
import { assertManifestLease, runManifestLeaseWork } from './persistence/manifest-lock.js';
import { readNndCompletionReceiptUnderOwnership } from './nnd-activation-completion-receipt.js';
import { readNndActivationJournal } from './nnd-activation-journal.js';
import { openInstallStore, readInstallBytes, writeInstallNew, hash, json, operationValid } from './nnd-install-storage.js';
import { exactRecord } from './nnd-service-contract.js';

const SHA = /^[a-f0-9]{64}$/u;
const JOURNAL = /^activation-0[0-8]\.json$/u;
const FILES = ['candidate.json', 'registration.before', 'child.json'];
const FILE_COUNT = FILES.length + 9;
const invalid = () => new ContractError('nnd_activation_retirement_invalid',
  'NND terminal retirement is unresolved; preserve the pending barrier and activation evidence.');
const samePath = (left, right) => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
function paths(identity, operationId) {
  const root = join(identity.data_root, 'runtime', 'nnd', 'install-slots');
  const activations = join(root, 'activations');
  return { plan: join(root, 'activation-retirement.json'), directory: join(activations, operationId),
    activations, marker: join(identity.data_root, 'runtime', 'nnd', 'installation-pending.json') };
}
function assertOwner(identity, serviceLease, registryLease, options) {
  if (!identity || !options || !operationValid(options.operationId)
    || !operationValid(options.stageOperationId) || !operationValid(options.generation)
    || Object.keys(options).some(key => !['operationId', 'stageOperationId', 'generation', 'signal'].includes(key))) throw invalid();
  assertHeldNndServiceLease(serviceLease, identity.data_id);
  const target = assertManifestLease(registryLease);
  if (!samePath(target.path, join(identity.data_root, 'config', 'nnd-package.json'))) throw invalid();
}
function assertLive(state, identity, serviceLease, options) {
  if (state?.identity !== identity || state.lease !== serviceLease || !state.retained
    || !state.retainedLeaseArmed || state.stopping || state.published || state.child?.failed
    || !state.child?.child || state.child.child.exitCode !== null
    || !state.native?.isListening?.() || !state.controller?.isListening?.()
    || state.record?.instance_id !== options.generation
    || state.activationOperationId !== options.operationId
    || state.stageOperationId !== options.stageOperationId) throw invalid();
}
function parsePlan(bytes, identity, options) {
  if (!bytes) return null;
  let plan;
  try { plan = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw invalid(); }
  if (!exactRecord(plan, ['protocol', 'state', 'operation_id', 'stage_operation_id', 'installation_id',
    'data_id', 'generation', 'completion_sha256', 'directory_ino', 'directory_dev', 'marker_sha256', 'files'])
    || !json(plan).equals(bytes) || plan.protocol !== '1.0' || plan.state !== 'planned_barred'
    || plan.operation_id !== options.operationId || plan.stage_operation_id !== options.stageOperationId
    || plan.installation_id !== identity.installation_id || plan.data_id !== identity.data_id
    || plan.generation !== options.generation || !SHA.test(plan.completion_sha256)
    || !SHA.test(plan.marker_sha256) || typeof plan.directory_ino !== 'string'
    || typeof plan.directory_dev !== 'string' || !Array.isArray(plan.files) || plan.files.length !== FILE_COUNT) throw invalid();
  const names = new Set(plan.files.map(file => file?.name));
  if (names.size !== FILE_COUNT || !FILES.every(name => names.has(name))
    || Array.from({ length: 9 }, (_, index) => `activation-0${index}.json`).some(name => !names.has(name))) throw invalid();
  for (const file of plan.files) if (!exactRecord(file, ['name', 'sha256', 'present'])
    || typeof file.name !== 'string' || (file.present && !SHA.test(file.sha256))
    || typeof file.present !== 'boolean' || !file.present && file.sha256 !== null
    || !FILES.includes(file.name) && !JOURNAL.test(file.name)) throw invalid();
  if (plan.files.some(file => JOURNAL.test(file.name) && !file.present)
    || plan.files.find(file => file.name === 'candidate.json')?.present !== true
    || plan.files.find(file => file.name === 'child.json')?.present !== true) throw invalid();
  return plan;
}
// The external decision reader needs to verify this exact canonical plan after
// journal files have been removed; parsing alone never attests live state.
export function parseNndTerminalRetirementPlanBytes(bytes, identity, options) {
  return parsePlan(bytes, identity, options);
}
async function fileBytes(path, limit, optional = false) {
  try { return await readInstallBytes(path, limit, optional); } catch { throw invalid(); }
}
async function observed(identity, options, receipt) {
  const location = paths(identity, options.operationId);
  const journal = await readNndActivationJournal({ ...identity, operation_id: options.operationId }, location.directory);
  if (journal.length !== 9 || journal[8].phase !== 'completed'
    || journal[8].receipt_sha256 !== receipt.receipt_sha256) throw invalid();
  const directory = await lstat(location.directory).catch(() => { throw invalid(); });
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw invalid();
  const marker = await fileBytes(location.marker, 1024);
  const expectedMarker = json({ protocol: '3.0', purpose: 'nnd_activation', operation_id: options.operationId,
    installation_id: identity.installation_id, data_id: identity.data_id,
    prepared_sha256: journal[0].receipt_sha256 });
  if (!marker.equals(expectedMarker)) throw invalid();
  const allowed = new Set(Array.from({ length: 9 }, (_, index) => `activation-0${index}.json`));
  let seen = 0;
  for await (const entry of await opendir(location.directory)) {
    if (!entry.isFile() || !allowed.has(entry.name) || ++seen > 9) throw invalid();
  }
  if (seen !== 9) throw invalid();
  const files = [];
  for (const name of FILES) {
    const suffix = name === 'candidate.json' ? '.candidate.json'
      : name === 'registration.before' ? '.registration.before' : '.child.json';
    const bytes = await fileBytes(join(location.activations, options.operationId + suffix), 16384, name === 'registration.before');
    if (!bytes && name !== 'registration.before') throw invalid();
    files.push({ name, sha256: bytes ? hash(bytes) : null, present: bytes !== null });
  }
  for (let index = 0; index < 9; index++) {
    const name = `activation-0${index}.json`;
    files.push({ name, sha256: hash(await fileBytes(join(location.directory, name), 2048)), present: true });
  }
  return { protocol: '1.0', state: 'planned_barred', operation_id: options.operationId,
    stage_operation_id: options.stageOperationId, installation_id: identity.installation_id,
    data_id: identity.data_id, generation: options.generation, completion_sha256: receipt.receipt_sha256,
    directory_ino: String(directory.ino), directory_dev: String(directory.dev),
    marker_sha256: hash(marker), files };
}
/** A plan is historical evidence only. It never claims barrier retirement or public readiness. */
export async function readNndTerminalRetirementPlanUnderOwnership(identity, serviceLease, registryLease, options) {
  assertOwner(identity, serviceLease, registryLease, options);
  return withNndServiceLease(serviceLease, identity.data_id, signal => runManifestLeaseWork(registryLease, async () => {
    try {
      signal.throwIfAborted();
      await openInstallStore(identity, signal, { readOnly: true });
      const location = paths(identity, options.operationId);
      const bytes = await fileBytes(location.plan, 4096, true);
      if (!bytes) return Object.freeze({ state: 'unknown', operation_id: options.operationId });
      const plan = parsePlan(bytes, identity, options);
      const receipt = await readNndCompletionReceiptUnderOwnership(identity, serviceLease, registryLease, options);
      if (receipt.state !== 'completion_recorded_barred' || receipt.receipt_sha256 !== plan.completion_sha256) throw invalid();
      const actual = await observed(identity, options, receipt);
      if (!json(actual).equals(bytes)) throw invalid();
      signal.throwIfAborted();
      return Object.freeze({ state: 'retirement_planned_barred', operation_id: options.operationId,
        generation: options.generation, completion_sha256: plan.completion_sha256,
        plan_sha256: hash(bytes) });
    } catch { throw invalid(); }
  }), { timeoutMs: 300000 });
}
/** Persist exact cleanup intent only after the historical completed decision is verified. */
export async function planNndTerminalRetirementUnderOwnership(identity, state, serviceLease, registryLease, options) {
  assertOwner(identity, serviceLease, registryLease, options);
  assertLive(state, identity, serviceLease, options);
  return withNndServiceLease(serviceLease, identity.data_id, leaseSignal => runManifestLeaseWork(registryLease, async () => {
    const signal = AbortSignal.any([leaseSignal, AbortSignal.timeout(30000),
      ...(options.signal ? [options.signal] : [])]);
    try {
      await openInstallStore(identity, signal, { readOnly: true });
      const receipt = await readNndCompletionReceiptUnderOwnership(identity, serviceLease, registryLease, options);
      if (receipt.state !== 'completion_recorded_barred') throw invalid();
      const plan = await observed(identity, options, receipt);
      const bytes = json(plan);
      if (bytes.length > 4096) throw invalid();
      assertLive(state, identity, serviceLease, options);
      signal.throwIfAborted();
      await writeInstallNew(paths(identity, options.operationId).plan, bytes);
      const result = await readNndTerminalRetirementPlanUnderOwnership(identity, serviceLease, registryLease, options);
      if (result.plan_sha256 !== hash(bytes)) throw invalid();
      signal.throwIfAborted();
      return result;
    } catch { throw invalid(); }
  }), { timeoutMs: 300000 });
}
