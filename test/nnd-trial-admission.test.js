// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ContractError } from '../src/ids.js';

async function fixture() {
  const identity = { data_root: 'C:\\nna-gate', data_id: 'data_id', installation_id: 'nna_id' };
  const serviceLease = {}, registryLease = {};
  let serviceHeld = true, registryHeld = true;
  const state = { identity, lease: serviceLease, unpublishedTrial: true, published: false, stopping: false,
    activationOperationId: 'operation', stageOperationId: 'stage', record: { instance_id: 'generation' },
    child: { failed: false, child: { exitCode: null } } };
  const binding = { operationId: 'operation', stageOperationId: 'stage' };
  const source = await readFile(new URL('../src/nnd-trial-admission.js', import.meta.url), 'utf8');
  const executable = source.replace(/^import\s[\s\S]*?;\r?\n/gm, '').replaceAll('export function', 'function');
  const api = Function('join', 'resolve', 'ContractError', 'assertHeldNndServiceLease', 'assertManifestLease',
    'operationValid', executable + '\nreturn { createNndTrialAdmissionGate, assertNndTrialRequestAdmission };')(
    join, resolve, ContractError,
    (lease, dataId) => { if (!serviceHeld || lease !== serviceLease || dataId !== identity.data_id) throw Error('lease lost'); },
    lease => { if (!registryHeld || lease !== registryLease) throw Error('registry lost');
      return { path: join(identity.data_root, 'config', 'nnd-package.json') }; },
    value => ['operation', 'stage', 'generation'].includes(value));
  const gate = api.createNndTrialAdmissionGate(identity, state, serviceLease, registryLease, binding);
  return { identity, serviceLease, registryLease, state, binding, gate, api,
    loseService: () => { serviceHeld = false; }, loseRegistry: () => { registryHeld = false; } };
}

test('unpublished native gate permits reads and denies every ordinary mutation regardless of principal', async () => {
  const f = await fixture();
  for (const method of ['GET', 'HEAD']) assert.doesNotThrow(() => f.api.assertNndTrialRequestAdmission(f.gate, f.identity, { method }));
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    assert.throws(() => f.api.assertNndTrialRequestAdmission(f.gate, f.identity, { method }),
      { code: 'nnd_trial_mutation_denied' });
  }
  assert.throws(() => f.api.assertNndTrialRequestAdmission({}, f.identity, { method: 'GET' }),
    { code: 'nnd_trial_admission_invalid' });
});

test('the gate fails closed after generation, operation, child or ownership changes', async () => {
  const changes = [
    f => { f.state.record = { instance_id: 'other' }; },
    f => { f.state.activationOperationId = 'other'; },
    f => { f.state.child.failed = true; },
    f => { f.state.child.child.exitCode = 1; },
    f => { f.state.stopping = true; },
    f => { f.state.published = true; },
    f => f.loseService(),
    f => f.loseRegistry(),
  ];
  for (const change of changes) {
    const f = await fixture(); change(f);
    assert.throws(() => f.api.assertNndTrialRequestAdmission(f.gate, f.identity, { method: 'GET' }),
      { code: 'nnd_trial_admission_invalid' });
  }
  const foreign = await fixture();
  assert.throws(() => foreign.api.assertNndTrialRequestAdmission(foreign.gate, { ...foreign.identity }, { method: 'GET' }),
    { code: 'nnd_trial_admission_invalid' });
});
