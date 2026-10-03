// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ContractError } from '../src/ids.js';

async function proofFunctions() {
  const source = await readFile(new URL('../src/nnd-activation-principal-proof.js', import.meta.url), 'utf8');
  const executable = source.replace(/^import\s[\s\S]*?;\r?\n/gm, '').replaceAll('export function', 'function');
  let held = true, registryHeld = true;
  const functions = Function('join', 'resolve', 'ContractError', 'assertHeldNndServiceLease', 'assertManifestLease',
    executable + '\nreturn { issueNndPrincipalTransitionProof, consumeNndPrincipalTransitionProof };')(
    join, resolve, ContractError,
    () => { if (!held) throw Error('lease lost'); },
    () => { if (!registryHeld) throw Error('registry lost'); return { path: join('C:\\root', 'config', 'nnd-package.json') }; });
  return { ...functions, loseLease: () => { held = false; }, loseRegistry: () => { registryHeld = false; } };
}

function fixture() {
  const identity = { data_root: 'C:\\root', installation_id: 'nna_1', data_id: 'data_1' };
  const native = { isListening: () => true };
  const state = { published: false, stopping: false, registrationSelected: true,
    record: { instance_id: 'generation' }, native, controller: { isListening: () => true },
    child: { failed: false, child: { pid: 123, exitCode: null } } };
  const serviceLease = {}, registryLease = {};
  const options = { operationId: 'operation', stageOperationId: 'stage', generation: 'generation' };
  const health = { state: 'published_healthy_unresolved', operation_id: 'operation', generation: 'generation',
    registration_revision: 'a'.repeat(64), journal_sha256: 'b'.repeat(64), native_state: 'ready' };
  return { identity, state, serviceLease, registryLease, options, health, signal: new AbortController() };
}

test('private transition proof is opaque, one-use and bound to the held same process', async () => {
  const api = await proofFunctions(); const f = fixture();
  const { proof } = api.issueNndPrincipalTransitionProof(f.identity, f.state, f.serviceLease,
    f.registryLease, f.options, f.health, f.signal.signal);
  assert.deepEqual(proof, {});
  assert.throws(() => api.consumeNndPrincipalTransitionProof({}, f.identity, f.state,
    f.serviceLease, f.registryLease, f.options), { code: 'nnd_activation_transition_proof_invalid' });
  assert.deepEqual(api.consumeNndPrincipalTransitionProof(proof, f.identity, f.state,
    f.serviceLease, f.registryLease, f.options), {
    operation_id: 'operation', stage_operation_id: 'stage', generation: 'generation',
    registration_revision: 'a'.repeat(64), journal_sha256: 'b'.repeat(64), native_state: 'ready' });
  assert.throws(() => api.consumeNndPrincipalTransitionProof(proof, f.identity, f.state,
    f.serviceLease, f.registryLease, f.options), { code: 'nnd_activation_transition_proof_invalid' });
});

test('foreign identity, dead child, stopped listener, lost ownership and retired proof fail closed', async () => {
  const cases = [
    (f) => { f.state.child.child.exitCode = 1; },
    (f) => { f.state.stopping = true; },
    (f) => { f.state.native.isListening = () => false; },
    (f) => { f.signal.abort(); },
  ];
  for (const change of cases) {
    const api = await proofFunctions(); const f = fixture();
    const issued = api.issueNndPrincipalTransitionProof(f.identity, f.state, f.serviceLease,
      f.registryLease, f.options, f.health, f.signal.signal);
    change(f);
    assert.throws(() => api.consumeNndPrincipalTransitionProof(issued.proof, f.identity, f.state,
      f.serviceLease, f.registryLease, f.options), { code: 'nnd_activation_transition_proof_invalid' });
  }
  const api = await proofFunctions(); const f = fixture();
  const issued = api.issueNndPrincipalTransitionProof(f.identity, f.state, f.serviceLease,
    f.registryLease, f.options, f.health, f.signal.signal);
  assert.throws(() => api.consumeNndPrincipalTransitionProof(issued.proof, { ...f.identity }, f.state,
    f.serviceLease, f.registryLease, f.options), { code: 'nnd_activation_transition_proof_invalid' });
  assert.throws(() => api.consumeNndPrincipalTransitionProof(issued.proof, f.identity, f.state,
    f.serviceLease, f.registryLease, f.options), { code: 'nnd_activation_transition_proof_invalid' });
  const second = api.issueNndPrincipalTransitionProof(f.identity, f.state, f.serviceLease,
    f.registryLease, f.options, f.health, f.signal.signal);
  second.retire();
  assert.throws(() => api.consumeNndPrincipalTransitionProof(second.proof, f.identity, f.state,
    f.serviceLease, f.registryLease, f.options), { code: 'nnd_activation_transition_proof_invalid' });
  const third = api.issueNndPrincipalTransitionProof(f.identity, f.state, f.serviceLease,
    f.registryLease, f.options, f.health, f.signal.signal);
  api.loseLease();
  assert.throws(() => api.consumeNndPrincipalTransitionProof(third.proof, f.identity, f.state,
    f.serviceLease, f.registryLease, f.options), { code: 'nnd_activation_transition_proof_invalid' });
});
