// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { ContractError } from '../src/ids.js';
import { nativeNndTrialPrincipal, nativeNndPrincipal } from '../src/nnd-service-native.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const identity = { installation_id: `nna_${'a'.repeat(64)}`, data_id: `data_${'b'.repeat(64)}`,
  data_root: 'C:\\NNA-data' };
const stageOperationId = randomUUID(), operationId = randomUUID();
async function harness(overrides = {}) {
  const trace = [], lease = Object.freeze({}), registryLease = Object.freeze({});
  const controller = new AbortController();
  const proof = { installation_id: identity.installation_id, data_id: identity.data_id,
    generation: 'generation-1', version: '20261002-8', native_state: 'setup_required', gui_http_status: 200 };
  const owner = { status: () => ({ installation_id: identity.installation_id, data_id: identity.data_id,
    instance_id: proof.generation, package_version: proof.version }),
  verify: async () => { trace.push('verify'); return overrides.verify ? overrides.verify(proof) : proof; },
  prepareDiscovery: async () => { trace.push('prepare-discovery'); return { instance_id: proof.generation }; },
  stop: async () => { trace.push('stop'); if (overrides.stop) return overrides.stop(); } };
  const dependencies = { join, resolve, ContractError,
    assertHeldNndServiceLease: actual => { assert.equal(actual, lease); trace.push('lease:assert'); },
    withNndServiceLease: (_lease,_dataId,operation) => operation(controller.signal),
    assertManifestLease: actual => { assert.equal(actual, registryLease); trace.push('registry:assert');
      return { path: join(identity.data_root, 'config', 'nnd-package.json') }; },
    runManifestLeaseWork: (_lease,operation) => operation(),
    prepareNndActivationUnderOwnership: async () => { trace.push('prepare'); await overrides.prepare?.(controller); return {
      state: 'prepared', version: proof.version, payload_sha256: digest('payload') }; },
    issueNndTrialCapability: async () => { trace.push('capability'); return Object.freeze({}); },
    appendNndActivationPhase: async (_id,_directory,_lease,_registry,phase) => { trace.push(phase); },
    startNndOwnedTrial: async () => { trace.push('start'); return owner; },
    hash: value => digest(value), json: value => Buffer.from(JSON.stringify(value)),
    operationValid: value => value === stageOperationId || value === operationId };
  const source = await readFile(new URL('../src/nnd-activation-trial.js', import.meta.url), 'utf8');
  const executable = source.replace(/^import\s[\s\S]*?;\r?\n/gm, '').replaceAll('export async function', 'async function');
  const run = Function(...Object.keys(dependencies), executable + '\nreturn runNndUnpublishedTrialUnderOwnership;')
    (...Object.values(dependencies));
  return { run: options => run(identity, {}, lease, registryLease,
    { stageOperationId, operationId, ...options }), trace, proof, lease, registryLease, controller };
}
test('owned trial holds lease and registry through preparation, unpublished health, and confirmed stop', async () => {
  const f = await harness();
  const result = await f.run();
  assert.deepEqual(f.trace.filter(item => !item.endsWith(':assert')),
    ['prepare','capability','trial_starting','start','trial_running','verify','trial_healthy','verify','stop']);
  assert.equal(result.state, 'trial_healthy'); assert.equal(result.generation, f.proof.generation);
});
test('trusted continuation observes the same live unpublished child and both original locks', async () => {
  const f = await harness();
  const result = await f.run({ continuation: async ({ proof, status, prepareDiscovery, serviceLease, registryLease, signal }) => {
    assert.equal(proof.generation, f.proof.generation);
    assert.equal(status().instance_id, proof.generation);
    assert.equal(signal.aborted, false);
    assert.equal(serviceLease, f.lease); assert.equal(registryLease, f.registryLease);
    assert.equal(f.trace.includes('stop'), false);
    assert.equal((await prepareDiscovery()).instance_id, proof.generation);
    f.trace.push('continuation');
    return 'held-live';
  } });
  assert.equal(result.continuation_result, 'held-live');
  assert.deepEqual(f.trace.filter(item => ['trial_healthy','continuation','verify','stop'].includes(item)),
    ['verify','trial_healthy','continuation','verify','stop']);
});
test('health failure leaves no healthy receipt and confirms child stop before returning', async () => {
  const f = await harness({ verify: () => { throw new ContractError('nnd_health_unavailable', 'GUI gone'); } });
  await assert.rejects(f.run(), { code: 'nnd_health_unavailable' });
  assert.deepEqual(f.trace.filter(item => !item.endsWith(':assert')),
    ['prepare','capability','trial_starting','start','trial_running','verify','stop']);
});
test('expired ownership during slow preparation does not advance the trial journal or start a child', async () => {
  const f = await harness({ prepare: controller => controller.abort() });
  await assert.rejects(f.run(), { name: 'AbortError' });
  assert.deepEqual(f.trace.filter(item => !item.endsWith(':assert')), ['prepare']);
});
test('expired ownership during continuation still confirms trial child shutdown', async () => {
  const f = await harness();
  await assert.rejects(f.run({ continuation: () => f.controller.abort() }), { name: 'AbortError' });
  assert.equal(f.trace.filter(item => !item.endsWith(':assert')).at(-1), 'stop');
  assert.equal(f.trace.includes('trial_healthy'), true);
});
test('unconfirmed writer stop is surfaced without claiming a settled trial', async () => {
  const f = await harness({ stop: () => { throw new Error('writer still alive'); } });
  await assert.rejects(f.run(), /retain both ownership locks and the admission barrier/u);
  assert.equal(f.trace.at(-1), 'stop');
});
test('trial native principal admits inspection while denying all interactive mutations', () => {
  const trial = nativeNndTrialPrincipal('C:\\workspace');
  const normal = nativeNndPrincipal('C:\\workspace');
  assert.ok(trial.permissions.includes('nnd.configuration.read'));
  assert.ok(normal.permissions.includes('nnd.session.create'));
  for (const permission of trial.permissions) assert.match(permission, /(?:\.read|\.health)$/u);
  assert.equal(trial.permissions.some(permission => permission.includes('manage') || permission.includes('activate')), false);
});
