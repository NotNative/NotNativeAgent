// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const stageOperationId = '11111111-1111-4111-8111-111111111111';
const operationId = '22222222-2222-4222-8222-222222222222';
// The real trial generation is the selected discovery instance UUID, never a
// number. Reusing a numeric fake would hide a type-confusion defect.
const generation = '33333333-3333-4333-8333-333333333333';
const identity = { data_root: 'C:/private', installation_id: 'nna_selected', data_id: 'data_selected' };

// The retained owner mirror: it records each (registryLease, options) pair and
// returns the exact contract state the orchestrator must accept, in order.
const TERMINAL_STATES = {
  recordCompletion: 'completion_recorded_barred',
  planRetirement: 'retirement_planned_barred',
  recordRetirementDecision: 'retirement_decision_recorded_barred',
  cleanupRetirement: 'retirement_evidence_cleaned_barred',
  commitRetirement: 'terminal_committed_barred',
  clearRetirementBarriers: 'barriers_cleared_admission_barred',
  transferNativeAdmission: 'native_admission_transferred_controller_dark',
};
function retainedOwner({ trace, states = {} }) {
  const owner = {
    stop: async () => { trace.push('stop'); },
    stopped: Promise.resolve({}),
  };
  for (const [method, expected] of Object.entries(TERMINAL_STATES)) {
    owner[method] = async (registryLease, options) => {
      trace.push([method, registryLease, options]);
      return states[method] ?? { state: expected, operation_id: operationId, generation };
    };
  }
  owner.publishController = async (registryLease, options) => {
    trace.push(['publishController', registryLease, options]);
    return states.publishController ?? { state: 'public_controller_attached',
      operation_id: operationId, generation, endpoint: 'http://127.0.0.1:9' };
  };
  return owner;
}

async function harness(overrides = {}) {
  const source = await readFile(new URL('../src/nnd-activation-orchestration.js', import.meta.url), 'utf8');
  const executable = source.replace(/^import .*?;\r?\n/gmu, '').replaceAll('export async function ', 'async function ');
  const trace = [];
  const registryLease = { registry: true };
  let closed = 0;
  const lease = { close: async () => { closed += 1; trace.push('close'); } };
  const trialResult = overrides.trialResult ?? { state: 'quarantined_owner_held_unresolved', generation,
    owner: retainedOwner({ trace, states: overrides.states }) };
  const dependencies = {
    join: (...parts) => parts.join('/'),
    ContractError: class ContractError extends Error { constructor(code, message) { super(message); this.code = code; } },
    acquireNndServiceLock: async () => { trace.push('lease'); return lease; },
    withManifestLock: async (_path, _options, operation) => { trace.push('registry'); return operation(registryLease); },
    readNndActivationCandidate: async () => { trace.push('candidate'); return { evidence: { version: 'x', payload_sha256: 'a'.repeat(64) }, evidence_sha256: 'b'.repeat(64) }; },
    runNndUnpublishedTrialUnderOwnership: async (trialIdentity, paths, serviceLease, registry, options) => {
      trace.push(['trial', options, paths, serviceLease, registry]);
      return trialResult;
    },
    operationValid: value => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value ?? ''),
    assertNoNndInstallMarker: async () => { trace.push('marker'); },
    assertNoNndInstallTransaction: async () => { trace.push('transaction'); },
    assertNoNndMigration: async () => { trace.push('migration'); },
    scanNndLegacyOwners: async () => { trace.push('census'); },
    userDataPaths: () => ({ data: 'C:/private/data', config: 'C:/private/config', logs: 'C:/private/logs' }),
    ...overrides.deps,
  };
  const api = Function(...Object.keys(dependencies), `${executable}\nreturn { activateNndSlotUnderOwnership };`)
    (...Object.values(dependencies));
  return { ...api, trace, registryLease, closedLeases: () => closed };
}

// Drive the trial's real continuation and final-window callbacks through a
// context that mirrors the trial's frozen shapes.
function driveCallbacks() {
  const selection = [];
  const finalSeen = [];
  return {
    selection, finalSeen,
    makeContinuationContext: () => ({ selectRegistration: args => { selection.push(args); return { state: 'registration_selected_unresolved' }; } }),
    makeFinalContext: () => ({
      withFinalOwnership: async operation => operation({
        verifyHeldTicket: async () => { finalSeen.push('ticket'); return { state: 'held_private_ticket_verified_unresolved' }; },
        promotePrivatePrincipal: async () => { finalSeen.push('promote'); return { state: 'native_principal_promoted_unresolved' }; },
        probePromotedPrivateAttach: async () => { finalSeen.push('probe'); return { state: 'promoted_private_attach_verified_unresolved' }; },
        recordPromotedPrivateAttach: async () => { finalSeen.push('record'); return { state: 'promoted_attach_recorded_unresolved' }; },
        retainQuarantinedOwner: () => { finalSeen.push('retain'); return { transferNativeAdmission: async () => ({ state: 'native_admission_transferred_controller_dark' }) }; },
      }),
    }),
  };
}

test('activation refuses equal or malformed UUIDs before acquiring any owner', async () => {
  const f = await harness();
  for (const options of [{ stageOperationId, operationId: stageOperationId },
    { stageOperationId: 'bad', operationId }, { stageOperationId, operationId: 'bad' }]) {
    await assert.rejects(f.activateNndSlotUnderOwnership(identity, options), { code: 'nnd_activation_candidate_invalid' });
  }
  assert.deepEqual(f.trace, []);
});

test('activation drives the trial then the full terminal sequence in strict order', async () => {
  const f = await harness();
  const result = await f.activateNndSlotUnderOwnership(identity, { stageOperationId, operationId });
  const steps = f.trace.map(item => (Array.isArray(item) ? item[0] : item));
  assert.deepEqual(steps, ['lease', 'marker', 'transaction', 'migration', 'census', 'registry', 'candidate',
    'trial', 'recordCompletion', 'planRetirement', 'recordRetirementDecision', 'cleanupRetirement',
    'commitRetirement', 'clearRetirementBarriers', 'transferNativeAdmission', 'publishController']);
  // Each terminal step receives the genuine registry lease and the full binding.
  const options = { operationId, stageOperationId, generation, signal: undefined };
  for (const step of ['recordCompletion', 'planRetirement', 'recordRetirementDecision', 'cleanupRetirement',
    'commitRetirement', 'clearRetirementBarriers', 'transferNativeAdmission', 'publishController']) {
    const entry = f.trace.find(item => Array.isArray(item) && item[0] === step);
    assert.equal(entry[1], f.registryLease);
    assert.deepEqual(entry[2], options);
  }
  assert.deepEqual({ state: result.state, operation_id: result.operation_id,
    stage_operation_id: result.stage_operation_id, generation: result.generation, endpoint: result.endpoint },
  { state: 'public_controller_attached', operation_id: operationId,
    stage_operation_id: stageOperationId, generation, endpoint: 'http://127.0.0.1:9' });
});

test('a numeric trial generation is refused and stops the retained owner without closing the lease', async () => {
  const stopTrace = [];
  const badGenerationOwner = retainedOwner({ trace: stopTrace });
  const f = await harness({ trialResult: { state: 'quarantined_owner_held_unresolved', generation: 4242,
    owner: badGenerationOwner } });
  await assert.rejects(f.activateNndSlotUnderOwnership(identity, { stageOperationId, operationId }),
    { code: 'nnd_activation_candidate_invalid' });
  // The trial handed the lease to the retained owner. A post-handoff
  // refusal cannot strand that generation; the owner's exact stop protocol
  // must release it, while the orchestrator never closes the lease directly.
  assert.deepEqual(stopTrace, ['stop']);
  assert.equal(f.closedLeases(), 0);
});

test('the retained owner keeps the singleton lease; the orchestrator never closes it', async () => {
  const f = await harness();
  const result = await f.activateNndSlotUnderOwnership(identity, { stageOperationId, operationId });
  assert.equal(f.closedLeases(), 0);
  assert.equal(typeof result.owner.stop, 'function');
});

test('trial continuation selects registration and final window promotes then retains the owner', async () => {
  const f = await harness();
  await f.activateNndSlotUnderOwnership(identity, { stageOperationId, operationId });
  const trialOptions = f.trace.find(item => Array.isArray(item) && item[0] === 'trial')[1];
  const d = driveCallbacks();
  assert.deepEqual(await trialOptions.continuation(d.makeContinuationContext()),
    { state: 'registration_selected_unresolved' });
  assert.deepEqual(d.selection, [{ operationId, stageOperationId }]);
  const owner = await trialOptions.afterFinalVerification(d.makeFinalContext());
  assert.deepEqual(d.finalSeen, ['ticket', 'promote', 'probe', 'record', 'retain']);
  assert.equal(typeof owner.transferNativeAdmission, 'function');
});

test('a wrong terminal state aborts the sequence and stops the retained owner without closing the lease', async () => {
  const f = await harness({ states: { commitRetirement: { state: 'unexpected' } } });
  await assert.rejects(f.activateNndSlotUnderOwnership(identity, { stageOperationId, operationId }),
    { code: 'nnd_activation_transition_proof_invalid' });
  const steps = f.trace.map(item => (Array.isArray(item) ? item[0] : item));
  assert.deepEqual(steps, ['lease', 'marker', 'transaction', 'migration', 'census', 'registry', 'candidate',
    'trial', 'recordCompletion', 'planRetirement', 'recordRetirementDecision', 'cleanupRetirement', 'commitRetirement', 'stop']);
  assert.equal(f.closedLeases(), 0);
});

test('a pre-handoff refusal releases the orchestrator lease it opened', async () => {
  const f = await harness();
  await assert.rejects(f.activateNndSlotUnderOwnership(identity, { stageOperationId, operationId: 'bad' }),
    { code: 'nnd_activation_candidate_invalid' });
  assert.equal(f.closedLeases(), 0);
});

test('a trial that never retains an owner is refused without a terminal sequence', async () => {
  const f = await harness({ trialResult: { state: 'trial_healthy', generation } });
  await assert.rejects(f.activateNndSlotUnderOwnership(identity, { stageOperationId, operationId }),
    { code: 'nnd_activation_transition_proof_invalid' });
  const steps = f.trace.map(item => (Array.isArray(item) ? item[0] : item));
  assert.deepEqual(steps, ['lease', 'marker', 'transaction', 'migration', 'census', 'registry', 'candidate', 'trial', 'close']);
});

test('outer registry cleanup failure after a successful trial still stops the retained owner', async () => {
  const stopTrace = [];
  const f = await harness({
    deps: { withManifestLock: async (_path, _options, operation) => {
      const result = await operation(f.registryLease);
      throw new Error('registry cleanup failed');
    } },
    trialResult: { state: 'quarantined_owner_held_unresolved', generation,
      owner: {
        stop: async () => { stopTrace.push('stop'); }, stopped: Promise.resolve({}),
        transferNativeAdmission: async () =>
          ({ state: 'native_admission_transferred_controller_dark', operation_id: operationId, generation }),
        recordCompletion: async () => ({ state: 'completion_recorded_barred', operation_id: operationId, generation }),
        planRetirement: async () => ({ state: 'retirement_planned_barred', operation_id: operationId, generation }),
        recordRetirementDecision: async () =>
          ({ state: 'retirement_decision_recorded_barred', operation_id: operationId, generation }),
        cleanupRetirement: async () => ({ state: 'retirement_evidence_cleaned_barred', operation_id: operationId, generation }),
        commitRetirement: async () => ({ state: 'terminal_committed_barred', operation_id: operationId, generation }),
        clearRetirementBarriers: async () =>
          ({ state: 'barriers_cleared_admission_barred', operation_id: operationId, generation }),
        publishController: async () =>
          ({ state: 'public_controller_attached', operation_id: operationId, generation, endpoint: 'http://127.0.0.1:9' }),
      } } });
  await assert.rejects(f.activateNndSlotUnderOwnership(identity, { stageOperationId, operationId }),
    /registry cleanup failed/u);
  assert.deepEqual(stopTrace, ['stop']);
  assert.equal(f.closedLeases(), 0);
});
