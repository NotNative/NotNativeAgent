// SPDX-License-Identifier: Apache-2.0
/** Historical external retirement proof. It never removes evidence or opens admission. */
import { lstat, opendir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ContractError } from './ids.js';
import { assertHeldNndServiceLease, withNndServiceLease } from './nnd-service-lock.js';
import { assertManifestLease, runManifestLeaseWork } from './persistence/manifest-lock.js';
import { readLockedManifestSnapshot } from './persistence/manifest-transaction.js';
import { readNndPrivateTicketReceiptUnderOwnership } from './nnd-activation-ticket-receipt.js';
import { readNndTerminalRetirementPlanUnderOwnership,
  parseNndTerminalRetirementPlanBytes } from './nnd-activation-retirement-plan.js';
import { readNndServiceDiscovery } from './nnd-service-discovery.js';
import { captureDiscoveryProcessIdentity } from './nnd-service-discovery-windows.js';
import { openInstallStore, readInstallBytes, writeInstallNew, hash, json, operationValid } from './nnd-install-storage.js';
import { exactRecord } from './nnd-service-contract.js';
import { validIdentity } from './reliability/process-identity.js';

const SHA = /^[a-f0-9]{64}$/u;
const PLAN_LIMIT = 4096;
const DECISION_LIMIT = 4096;
const CHILD_LIMIT = 2048;
const CHILD_KEYS = ['protocol', 'operation_id', 'installation_id', 'data_id', 'generation', 'version', 'process_identity'];
const PROCESS_KEYS = ['version', 'pid', 'platform', 'start_id'];
const DECISION_KEYS = ['protocol', 'state', 'operation_id', 'stage_operation_id', 'installation_id',
  'data_id', 'generation', 'plan_sha256', 'completion_sha256', 'marker_sha256',
  'candidate_sha256', 'registration_before_sha256', 'child_sha256',
  'registration_revision', 'registration_operation_id', 'discovery_sha256', 'child_process_identity'];
const invalid = () => new ContractError('nnd_activation_retirement_decision_invalid',
  'NND external retirement decision is unresolved; preserve the pending barrier and activation evidence.');
const samePath = (left, right) => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
const location = (identity, operationId) => {
  const root = join(identity.data_root, 'runtime', 'nnd', 'install-slots');
  const activations = join(root, 'activations');
  return { plan: join(root, 'activation-retirement.json'), decision: join(root, 'activation-retirement-decision.json'),
    marker: join(identity.data_root, 'runtime', 'nnd', 'installation-pending.json'),
    activations, directory: join(activations, operationId) };
};
function assertOwner(identity, serviceLease, registryLease, options) {
  if (!identity || !options || !operationValid(options.operationId)
    || !operationValid(options.stageOperationId) || !operationValid(options.generation)
    || Object.keys(options).some(key => !['operationId', 'stageOperationId', 'generation', 'signal'].includes(key))) throw invalid();
  assertHeldNndServiceLease(serviceLease, identity.data_id);
  const target = assertManifestLease(registryLease);
  if (!samePath(target.path, join(identity.data_root, 'config', 'nnd-package.json'))) throw invalid();
}
function assertLive(state, identity, serviceLease, options) {
  if (state?.identity !== identity || state.lease !== serviceLease || !state.retained || !state.retainedLeaseArmed
    || state.stopping || state.published || state.child?.failed || !state.child?.child
    || state.child.child.exitCode !== null || !Number.isSafeInteger(state.child.child.pid)
    || state.child.child.pid < 1 || !state.native?.isListening?.() || !state.controller?.isListening?.()
    || state.record?.instance_id !== options.generation
    || state.activationOperationId !== options.operationId
    || state.stageOperationId !== options.stageOperationId) throw invalid();
}
async function bytes(path, limit, optional = false) {
  try { return await readInstallBytes(path, limit, optional); } catch { throw invalid(); }
}
function childRecord(raw, identity, options, plan) {
  let child;
  try { child = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { throw invalid(); }
  if (!exactRecord(child, CHILD_KEYS) || !exactRecord(child.process_identity, PROCESS_KEYS)
    || !json(child).equals(raw) || child.protocol !== '1.0'
    || child.operation_id !== options.operationId || child.installation_id !== identity.installation_id
    || child.data_id !== identity.data_id || child.generation !== options.generation
    || !validIdentity(child.process_identity) || child.process_identity.platform !== 'win32'
    || !/^\d{1,32}$/u.test(child.process_identity.start_id)
    || hash(raw) !== file(plan, 'child.json').sha256) throw invalid();
  return child;
}
function file(plan, name) {
  const found = plan.files.find(item => item.name === name);
  if (!found) throw invalid();
  return found;
}
function parseDecision(raw, identity, options, plan, planSha) {
  let decision;
  try { decision = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { throw invalid(); }
  if (!exactRecord(decision, DECISION_KEYS) || !json(decision).equals(raw)
    || decision.protocol !== '1.0' || decision.state !== 'decided_barred'
    || decision.operation_id !== options.operationId || decision.stage_operation_id !== options.stageOperationId
    || decision.installation_id !== identity.installation_id || decision.data_id !== identity.data_id
    || decision.generation !== options.generation || decision.plan_sha256 !== planSha
    || decision.completion_sha256 !== plan.completion_sha256
    || decision.marker_sha256 !== plan.marker_sha256
    || decision.candidate_sha256 !== file(plan, 'candidate.json').sha256
    || decision.registration_before_sha256 !== file(plan, 'registration.before').sha256
    || decision.child_sha256 !== file(plan, 'child.json').sha256
    || !SHA.test(decision.registration_revision)
    || decision.registration_operation_id !== `nnd-activate-${options.operationId}`
    || !SHA.test(decision.discovery_sha256)
    || !exactRecord(decision.child_process_identity, PROCESS_KEYS)
    || !validIdentity(decision.child_process_identity)
    || decision.child_process_identity.platform !== 'win32'
    || !/^\d{1,32}$/u.test(decision.child_process_identity.start_id)) throw invalid();
  return decision;
}
async function staticEvidence(identity, options, plan, allowRetired = false) {
  const place = location(identity, options.operationId);
  const marker = await bytes(place.marker, 1024, allowRetired);
  if (!marker && !allowRetired || marker && hash(marker) !== plan.marker_sha256) throw invalid();
  let expectedSidecars = 0, presentSidecars = 0, child = null;
  for (const [name, suffix, limit] of [['candidate.json', '.candidate.json', 4096],
    ['registration.before', '.registration.before', 16384], ['child.json', '.child.json', CHILD_LIMIT]]) {
    const expected = file(plan, name);
    const found = await bytes(join(place.activations, options.operationId + suffix), limit, allowRetired || !expected.present);
    if (!expected.present && found || !found && expected.present && !allowRetired
      || found && hash(found) !== expected.sha256) throw invalid();
    if (expected.present) expectedSidecars += 1;
    if (found) presentSidecars += 1;
    if (name === 'child.json' && found) child = childRecord(found, identity, options, plan);
  }
  const sidecarState = presentSidecars === expectedSidecars ? 'complete'
    : presentSidecars === 0 ? 'absent' : 'partial';
  let directory;
  try { directory = await lstat(place.directory); }
  catch (error) { if (error.code !== 'ENOENT') throw invalid(); }
  if (!directory) {
    if (!allowRetired) throw invalid();
    return { child, marker_state: marker ? 'present' : 'absent', sidecar_state: sidecarState,
      journal_state: 'absent' };
  }
  if (!directory.isDirectory() || directory.isSymbolicLink()
    || String(directory.ino) !== plan.directory_ino || String(directory.dev) !== plan.directory_dev) throw invalid();
  const seen = new Set();
  for await (const item of await opendir(place.directory)) {
    if (!item.isFile() || seen.has(item.name) || !plan.files.some(row => row.name === item.name && item.name.startsWith('activation-')))
      throw invalid();
    seen.add(item.name);
    const content = await bytes(join(place.directory, item.name), 2048);
    if (hash(content) !== file(plan, item.name).sha256) throw invalid();
  }
  if (!allowRetired && seen.size !== 9) throw invalid();
  return { child, marker_state: marker ? 'present' : 'absent', sidecar_state: sidecarState,
    journal_state: seen.size === 9 ? 'complete' : seen.size === 0 ? 'absent' : 'partial' };
}
async function selectedEvidence(identity, registryLease, options, decision) {
  const manifest = await readLockedManifestSnapshot(registryLease);
  if (manifest.revision !== decision.registration_revision || !manifest.rawBytes
    || hash(manifest.rawBytes) !== decision.registration_revision) throw invalid();
  const pointer = await readNndServiceDiscovery(identity);
  if (pointer && (pointer.instance_id !== options.generation || hash(json(pointer)) !== decision.discovery_sha256)) throw invalid();
  return pointer ? 'selected' : 'absent';
}
async function observed(identity, registryLease, options) {
  const place = location(identity, options.operationId);
  const decisionBytes = await bytes(place.decision, DECISION_LIMIT, true);
  if (!decisionBytes) return Object.freeze({ state: 'unknown', operation_id: options.operationId });
  const planBytes = await bytes(place.plan, PLAN_LIMIT);
  const plan = parseNndTerminalRetirementPlanBytes(planBytes, identity, options);
  const decision = parseDecision(decisionBytes, identity, options, plan, hash(planBytes));
  const evidence = await staticEvidence(identity, options, plan, true);
  if (evidence.child && !isDeepStrictEqual(decision.child_process_identity, evidence.child.process_identity)) throw invalid();
  const pointerState = await selectedEvidence(identity, registryLease, options, decision);
  return Object.freeze({ state: 'retirement_decision_recorded_barred', operation_id: options.operationId,
    generation: options.generation, decision_sha256: hash(decisionBytes), plan_sha256: decision.plan_sha256,
    journal_state: evidence.journal_state, sidecar_state: evidence.sidecar_state,
    marker_state: evidence.marker_state, pointer_state: pointerState });
}

/** Reopens the external decision even after journal removal; no success inference is made. */
export async function readNndExternalRetirementDecisionUnderOwnership(identity, serviceLease, registryLease, options) {
  assertOwner(identity, serviceLease, registryLease, options);
  return withNndServiceLease(serviceLease, identity.data_id, signal => runManifestLeaseWork(registryLease, async () => {
    try {
      signal.throwIfAborted();
      await openInstallStore(identity, signal, { readOnly: true });
      const result = await observed(identity, registryLease, options);
      signal.throwIfAborted();
      return result;
    } catch { throw invalid(); }
  }), { timeoutMs: 300000 });
}

/** Single-use durable decision. It records cleanup authority, not cleanup completion. */
export async function recordNndExternalRetirementDecisionUnderOwnership(identity, state, serviceLease, registryLease, options) {
  assertOwner(identity, serviceLease, registryLease, options);
  assertLive(state, identity, serviceLease, options);
  return withNndServiceLease(serviceLease, identity.data_id, leaseSignal => runManifestLeaseWork(registryLease, async () => {
    const signal = AbortSignal.any([leaseSignal, AbortSignal.timeout(30000),
      ...(options.signal ? [options.signal] : [])]);
    try {
      await openInstallStore(identity, signal, { readOnly: true });
      const planned = await readNndTerminalRetirementPlanUnderOwnership(identity, serviceLease, registryLease, options);
      if (planned.state !== 'retirement_planned_barred') throw invalid();
      const ticket = await readNndPrivateTicketReceiptUnderOwnership(identity, serviceLease, registryLease, options);
      if (ticket.state !== 'private_ticket_recorded_unresolved') throw invalid();
      const place = location(identity, options.operationId);
      const planBytes = await bytes(place.plan, PLAN_LIMIT);
      if (hash(planBytes) !== planned.plan_sha256) throw invalid();
      const plan = parseNndTerminalRetirementPlanBytes(planBytes, identity, options);
      const evidence = await staticEvidence(identity, options, plan);
      if (evidence.journal_state !== 'complete' || evidence.sidecar_state !== 'complete'
        || evidence.marker_state !== 'present'
        || state.child.child.pid !== evidence.child.process_identity.pid) throw invalid();
      const currentChild = await captureDiscoveryProcessIdentity(signal, evidence.child.process_identity.pid);
      if (!isDeepStrictEqual(currentChild, evidence.child.process_identity)) throw invalid();
      const manifest = await readLockedManifestSnapshot(registryLease);
      if (manifest.revision !== ticket.registration_revision || !manifest.rawBytes
        || hash(manifest.rawBytes) !== ticket.registration_revision) throw invalid();
      const pointer = await readNndServiceDiscovery(identity);
      if (pointer?.instance_id !== options.generation || !isDeepStrictEqual(pointer, state.record)) throw invalid();
      const decision = { protocol: '1.0', state: 'decided_barred', operation_id: options.operationId,
        stage_operation_id: options.stageOperationId, installation_id: identity.installation_id,
        data_id: identity.data_id, generation: options.generation, plan_sha256: planned.plan_sha256,
        completion_sha256: plan.completion_sha256, marker_sha256: plan.marker_sha256,
        candidate_sha256: file(plan, 'candidate.json').sha256,
        registration_before_sha256: file(plan, 'registration.before').sha256,
        child_sha256: file(plan, 'child.json').sha256,
        registration_revision: ticket.registration_revision,
        registration_operation_id: `nnd-activate-${options.operationId}`,
        discovery_sha256: hash(json(pointer)), child_process_identity: evidence.child.process_identity };
      const content = json(decision);
      if (content.length > DECISION_LIMIT) throw invalid();
      assertLive(state, identity, serviceLease, options);
      signal.throwIfAborted();
      await writeInstallNew(place.decision, content);
      const reopened = await observed(identity, registryLease, options);
      if (reopened.decision_sha256 !== hash(content) || reopened.journal_state !== 'complete'
        || reopened.sidecar_state !== 'complete' || reopened.marker_state !== 'present'
        || reopened.pointer_state !== 'selected') throw invalid();
      signal.throwIfAborted();
      return reopened;
    } catch { throw invalid(); }
  }), { timeoutMs: 300000 });
}
