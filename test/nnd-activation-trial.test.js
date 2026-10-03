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
  let selected = false;
  const owner = { status: () => ({ installation_id: identity.installation_id, data_id: identity.data_id,
    instance_id: proof.generation, package_version: proof.version }),
  verify: async () => { trace.push('verify'); return overrides.verify ? overrides.verify(proof) : proof; },
  prepareDiscovery: async () => { trace.push('prepare-discovery'); return { instance_id: proof.generation }; },
  selectRegistration: async () => { trace.push('select-registration');
    if (overrides.selectRegistration) {
      const result = await overrides.selectRegistration();
      if (result?.state === 'registration_selected_unresolved') selected = true;
      return result;
    }
    selected = true;
    return { state: 'registration_selected_unresolved' }; },
  registrationSelected: () => selected,
  trialChildPid: () => 4321,
  stop: async () => { trace.push('stop'); if (overrides.stop) return overrides.stop(); } };
  const child = { protocol: '1.0', operation_id: operationId,
    installation_id: identity.installation_id, data_id: identity.data_id,
    generation: proof.generation, version: proof.version,
    process_identity: { version: 1, pid: 4321, platform: 'win32', start_id: '123456789' } };
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
    readInstallBytes: async () => overrides.childEvidence === false ? null : Buffer.from(JSON.stringify(child)),
    operationValid: value => value === stageOperationId || value === operationId };
  const source = await readFile(new URL('../src/nnd-activation-trial.js', import.meta.url), 'utf8');
  const executable = source.replace(/^import\s[\s\S]*?;\r?\n/gm, '')
    .replaceAll('export async function', 'async function').replaceAll('export function', 'function');
  const { run, consume } = Function(...Object.keys(dependencies), executable
    + '\nreturn {run: runNndUnpublishedTrialUnderOwnership, consume: consumeNndStoppedTrialProof};')
    (...Object.values(dependencies));
  return { run: options => run(identity, {}, lease, registryLease,
    { stageOperationId, operationId, ...options }),
  consume: (token, overrides = {}) => consume(token, identity,
    overrides.lease ?? lease, overrides.registryLease ?? registryLease,
    { operationId, stageOperationId, generation: overrides.generation ?? proof.generation }),
  trace, proof, lease, registryLease, controller };
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
  const result = await f.run({ continuation: async ({ proof, status, prepareDiscovery, selectRegistration,
    serviceLease, registryLease, signal }) => {
    assert.equal(proof.generation, f.proof.generation);
    assert.equal(status().instance_id, proof.generation);
    assert.equal(signal.aborted, false);
    assert.equal(serviceLease, f.lease); assert.equal(registryLease, f.registryLease);
    assert.equal(f.trace.includes('stop'), false);
    assert.equal((await prepareDiscovery()).instance_id, proof.generation);
    assert.equal((await selectRegistration()).state, 'registration_selected_unresolved');
    f.trace.push('continuation');
    return 'held-live';
  } });
  assert.equal(result.continuation_result, 'held-live');
  assert.equal(result.state, 'registration_selected_unresolved');
  assert.deepEqual(f.trace.filter(item => ['trial_healthy','continuation','verify','stop'].includes(item)),
    ['verify','trial_healthy','continuation','verify','stop']);
});
test('a swallowed uncertain registration selection never returns trial_healthy', async () => {
  const uncertain = new ContractError('manifest_publication_unknown', 'CAS may have saved');
  const f = await harness({ selectRegistration: () => { throw uncertain; } });
  await assert.rejects(f.run({ continuation: async ({ selectRegistration }) => {
    try { await selectRegistration(); } catch { /* A caller may try to continue. */ }
    return 'misleading-success';
  } }), error => error === uncertain);
  assert.equal(f.trace.filter(item => !item.endsWith(':assert')).at(-1), 'stop');
  assert.equal(f.trace.includes('select-registration'), true);
});
test('an unawaited registration selection settles before trial child shutdown', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const f = await harness({ selectRegistration: () => pending });
  const running = f.run({ continuation: ({ selectRegistration }) => {
    void selectRegistration(); return 'continued';
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.trace.includes('select-registration'), true);
  assert.equal(f.trace.includes('stop'), false);
  finish({ state: 'registration_selected_unresolved' });
  const result = await running;
  assert.equal(result.state, 'registration_selected_unresolved');
  assert.equal(f.trace.filter(item => !item.endsWith(':assert')).at(-1), 'stop');
});
test('a retained registration selector is revoked when the continuation ends', async () => {
  const f = await harness(); let select;
  await f.run({ continuation: context => { select = context.selectRegistration; } });
  assert.throws(() => select(), { code: 'nnd_activation_registration_invalid' });
  assert.equal(f.trace.includes('select-registration'), false);
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
test('post-stop continuation receives one-use bound proof only after confirmed cleanup', async () => {
  const f = await harness(); let retained;
  const result = await f.run({ afterStop: async ({ generation, serviceLease, registryLease, withShutdownProof }) => {
    assert.equal(f.trace.filter(item => !item.endsWith(':assert')).at(-1), 'stop');
    assert.equal(generation, f.proof.generation);
    assert.equal(serviceLease, f.lease); assert.equal(registryLease, f.registryLease);
    return withShutdownProof(proof => {
      retained = proof;
      const evidence = f.consume(proof);
      assert.equal(evidence.generation, generation);
      assert.deepEqual(evidence.child_identity, { pid: 4321, start_id: '123456789',
        sha256: digest(Buffer.from(JSON.stringify({ protocol: '1.0', operation_id: operationId,
          installation_id: identity.installation_id, data_id: identity.data_id,
          generation, version: f.proof.version,
          process_identity: { version: 1, pid: 4321, platform: 'win32', start_id: '123456789' } }))) });
      assert.throws(() => f.consume(proof), { code: 'nnd_activation_shutdown_invalid' });
      return 'observed';
    });
  } });
  assert.equal(result.state, 'trial_healthy');
  assert.equal(result.post_stop_result, 'observed');
  assert.throws(() => f.consume(retained), { code: 'nnd_activation_shutdown_invalid' });
});
test('post-stop proof cannot use another mutex or generation', async () => {
  const f = await harness();
  await f.run({ afterStop: ({ withShutdownProof }) => withShutdownProof(proof => {
    assert.throws(() => f.consume(proof, { registryLease: {} }), { code: 'nnd_activation_shutdown_invalid' });
    assert.throws(() => f.consume(proof, { generation: 'other' }), { code: 'nnd_activation_shutdown_invalid' });
    assert.equal(f.consume(proof).child_identity.pid, 4321);
  }) });
});
test('uncertain selection reaches post-stop observation without hiding original failure', async () => {
  const uncertain = new ContractError('manifest_publication_unknown', 'CAS may have saved');
  const f = await harness({ selectRegistration: () => { throw uncertain; } });
  await assert.rejects(f.run({ continuation: ({ selectRegistration }) => selectRegistration(),
    afterStop: ({ prior_error, trial_result, withShutdownProof }) => {
      assert.equal(prior_error, uncertain); assert.equal(trial_result, null);
      assert.equal(f.trace.filter(item => !item.endsWith(':assert')).at(-1), 'stop');
      return withShutdownProof(proof => { assert.equal(f.consume(proof).child_identity.pid, 4321);
        return 'unresolved-evidence'; });
    } }), error => error instanceof AggregateError && error.errors[0] === uncertain
      && error.post_stop_result === 'unresolved-evidence');
});
test('unconfirmed stop never invokes post-stop continuation', async () => {
  const f = await harness({ stop: () => { throw new Error('child alive'); } });
  let called = false;
  await assert.rejects(f.run({ afterStop: () => { called = true; } }), /retain both ownership locks/u);
  assert.equal(called, false);
});
test('unawaited post-stop work settles before proof revocation and return', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const f = await harness(); let retained;
  const running = f.run({ afterStop: ({ withShutdownProof }) => {
    void withShutdownProof(async proof => { retained = proof; await pending; return f.consume(proof); });
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.trace.includes('stop'), true);
  let settled = false; running.finally(() => { settled = true; });
  assert.equal(settled, false);
  release(); await running;
  assert.throws(() => f.consume(retained), { code: 'nnd_activation_shutdown_invalid' });
});
test('missing child evidence and aborted ownership cannot authorize post-stop mutation', async () => {
  const missing = await harness({ childEvidence: false });
  await missing.run({ afterStop: ({ withShutdownProof }) => withShutdownProof(proof => {
    assert.throws(() => missing.consume(proof), { code: 'nnd_activation_shutdown_invalid' });
    return 'observation-only';
  }) });
  const aborted = await harness();
  await assert.rejects(aborted.run({ continuation: () => aborted.controller.abort(),
    afterStop: ({ withShutdownProof, signal }) => {
      assert.equal(signal.aborted, true);
      return withShutdownProof(proof => {
        assert.throws(() => aborted.consume(proof), { code: 'nnd_activation_shutdown_invalid' });
        return 'unresolved';
      });
    } }), { name: 'AbortError' });
});
test('trial native principal admits inspection while denying all interactive mutations', () => {
  const trial = nativeNndTrialPrincipal('C:\\workspace');
  const normal = nativeNndPrincipal('C:\\workspace');
  assert.ok(trial.permissions.includes('nnd.configuration.read'));
  assert.ok(normal.permissions.includes('nnd.session.create'));
  for (const permission of trial.permissions) assert.match(permission, /(?:\.read|\.health)$/u);
  assert.equal(trial.permissions.some(permission => permission.includes('manage') || permission.includes('activate')), false);
});
