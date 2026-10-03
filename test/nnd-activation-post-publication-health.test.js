// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ContractError } from '../src/ids.js';
import { serializeManifestBytes } from '../src/persistence/manifest-files.js';
import { exactRecord, isNndLoopbackEndpoint } from '../src/nnd-service-contract.js';
import { validIdentity } from '../src/reliability/process-identity.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value) + '\n');
function response(url, status, body) {
  const result = new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  Object.defineProperty(result, 'url', { value: url });
  return result;
}
async function verifier(dependencies) {
  const source = await readFile(new URL('../src/nnd-activation-post-publication-health.js', import.meta.url), 'utf8');
  const executable = source.replace(/^import\s[\s\S]*?;\r?\n/gm, '').replaceAll('export async function', 'async function');
  return Function(...Object.keys(dependencies), executable + '\nreturn verifyNndPublishedTrialHealthUnderOwnership;')
    (...Object.values(dependencies));
}
async function fixture(options = {}) {
  const operationId = randomUUID(), stageOperationId = randomUUID(), generation = randomUUID();
  const identity = { data_root: 'C:\\nna-health-test', installation_id: `nna_${'a'.repeat(64)}`,
    data_id: `data_${'b'.repeat(64)}` };
  const serviceLease = {}, registryLease = {}, version = '20261003-3';
  const packageInfo = { root: 'C:\\nna-health-test\\slot', version, protocol: '1.0', entrypoint: 'C:\\nna-health-test\\slot\\service.js' };
  const desired = serializeManifestBytes({ root: packageInfo.root, version, protocol: '1.0' });
  const childIdentity = { version: 1, pid: 4321, platform: 'win32', start_id: '123456789' };
  const parentIdentity = { version: 1, pid: 9876, platform: 'win32', start_id: '987654321' };
  const child = { protocol: '1.0', operation_id: operationId, installation_id: identity.installation_id,
    data_id: identity.data_id, generation, version, process_identity: childIdentity };
  const childBytes = json(child);
  const candidate = { evidence: { stage_operation_id: stageOperationId,
    payload_sha256: hash('payload'), desired_registration_sha256: hash(desired) }, package: packageInfo };
  candidate.evidence_sha256 = hash(json(candidate.evidence));
  const record = { version: '1.0', purpose: 'nnd_service_control', installation_id: identity.installation_id,
    data_id: identity.data_id, instance_id: generation, endpoint: 'http://127.0.0.1:5003',
    control_token: 'x'.repeat(43), process_identity: parentIdentity, created_at: '2026-10-03T00:00:00.000Z' };
  const state = { registrationSelected: true, published: false, stopping: false,
    package: packageInfo, record, controller: { endpoint: record.endpoint, isListening: () => !options.closedController },
    uiHealthKey: Buffer.alloc(32, 0x58).toString('base64url'),
    ui: 'http://127.0.0.1:5002', native: { endpoint: 'http://127.0.0.1:5001', token: 'y'.repeat(43),
      isListening: () => !options.closedNative,
      runtime: { snapshot: () => ({ service_state: options.degraded ? 'degraded' : 'ready' }) } },
    child: { failed: false, child: { pid: childIdentity.pid, exitCode: null } } };
  const activation = join(identity.data_root, 'runtime', 'nnd', 'install-slots', 'activations');
  const marker = json({ protocol: '3.0', purpose: 'nnd_activation', operation_id: operationId,
    installation_id: identity.installation_id, data_id: identity.data_id, prepared_sha256: hash('prepared') });
  const files = new Map([[join(identity.data_root, 'runtime', 'nnd', 'installation-pending.json'), marker],
    [join(activation, `${operationId}.candidate.json`), json(candidate.evidence)],
    [join(activation, `${operationId}.child.json`), childBytes]]);
  const journal = [{ phase: 'prepared', receipt_sha256: hash('prepared'), evidence_sha256: candidate.evidence_sha256 },
    { phase: 'trial_starting', evidence_sha256: hash(json({ operation_id: operationId,
      stage_operation_id: stageOperationId, installation_id: identity.installation_id,
      data_id: identity.data_id, version, payload_sha256: candidate.evidence.payload_sha256 })) },
    { phase: 'trial_running', evidence_sha256: hash(json({ installation_id: identity.installation_id,
      data_id: identity.data_id, generation, version })) }, { phase: 'trial_healthy' },
    { phase: 'registration_cas', evidence_sha256: hash(json({ operation_id: operationId,
      before_revision: 'absent', after_revision: hash(desired), child_sha256: hash(childBytes) })) },
    { phase: 'discovery_published', receipt_sha256: hash('published'), evidence_sha256: hash(json({
      operation_id: operationId, registration_revision: hash(desired), child_sha256: hash(childBytes),
      generation, discovery_sha256: hash(json(record)) })) }];
  let pointer = options.foreignPointer ? { ...record, instance_id: randomUUID() } : record;
  let probes = 0, attachTickets = 0;
  const fetchImpl = async (url, init) => {
    probes++;
    if (options.stopDuringProbe && url === `${state.ui}/health`) state.child.child.exitCode = 1;
    if (url === `${state.native.endpoint}/v1/health`) {
      assert.equal(init.headers.authorization, `Bearer ${state.native.token}`);
      return response(url, 200, { instance_id: identity.installation_id, service_state: 'ready' });
    }
    if (url === `${state.ui}/health`) {
      if (options.changeEvidenceDuringProbe) files.set(join(activation, `${operationId}.child.json`),
        json({ ...child, extra: true }));
      return response(url, options.badGui ? 500 : 200, { ok: !options.badGui, runtime: 'service' });
    }
    if (url === `${state.ui}/__nna/health-proof`) {
      assert.equal(init.method, 'POST');
      const { nonce } = JSON.parse(init.body);
      assert.match(nonce, /^[A-Za-z0-9_-]{43}$/u);
      if (options.spoofUi) return response(url, 404, { error: 'unknown route' });
      const key = Buffer.from(options.foreignUiKey ? Buffer.alloc(32, 0x59).toString('base64url')
        : state.uiHealthKey, 'base64url');
      const mac = createHmac('sha256', key).update(JSON.stringify(['NND_SUPERVISED_HEALTH_V1', nonce,
        identity.installation_id, identity.data_id, generation, state.ui])).digest('hex');
      return response(url, 200, { protocol: '1.0', mac });
    }
    if (url === `${record.endpoint}/status` || url === `${record.endpoint}/attach`) {
      assert.equal(init.headers.authorization, `Bearer ${record.control_token}`);
      assert.equal(init.headers['x-nnd-generation'], generation);
      if (url.endsWith('/attach') && options.attachOpen) { attachTickets++; return response(url, 200, { ticket: 'unsafe' }); }
      return response(url, 401, { error: 'unauthenticated' });
    }
    throw Error('unexpected health target');
  };
  const dependencies = { isDeepStrictEqual, join, resolve, createHmac, randomBytes, timingSafeEqual,
    ContractError, serializeManifestBytes,
    exactRecord, isNndLoopbackEndpoint, validIdentity, hash, json,
    operationValid: value => [operationId, stageOperationId, generation].includes(value),
    assertHeldNndServiceLease: lease => { if (lease !== serviceLease) throw Error('foreign service lease'); },
    withNndServiceLease: (_lease, _dataId, callback) => callback(new AbortController().signal),
    assertManifestLease: lease => { if (lease !== registryLease) throw Error('foreign registry lease');
      return { path: join(identity.data_root, 'config', 'nnd-package.json') }; },
    runManifestLeaseWork: (_lease, callback) => callback(),
    readNndActivationJournal: async () => journal,
    readNndSelectedActivationCandidate: async () => candidate,
    readInstallBytes: async path => files.get(path) ?? null,
    readLockedManifestOperation: async () => options.foreignReceipt ? null : {
      persistence: 'saved', beforeRevision: 'absent', persistedRevision: hash(desired) },
    readLockedManifestSnapshot: async () => ({ rawBytes: options.foreignRegistration ? Buffer.from('foreign') : desired }),
    readNndPrivateDiscoveryGeneration: async () => record,
    readNndServiceDiscovery: async () => pointer,
    captureDiscoveryProcessIdentity: async (_signal, pid) => pid === undefined ? parentIdentity
      : options.reusedPid ? { ...childIdentity, start_id: '999' } : childIdentity,
    issueNndPrincipalTransitionProof: () => {
      const proof = Object.freeze({}); let retired = false;
      return { proof, retire: () => { retired = true; options.onProofRetired?.(); }, get retired() { return retired; } };
    } };
  const run = await verifier(dependencies);
  return { run: (more = {}) => run(identity, state, serviceLease, registryLease,
    { operationId, stageOperationId, generation, fetchImpl, ...more }),
    state, journal, files, identity, operationId, get probes() { return probes; },
    get attachTickets() { return attachTickets; }, set pointer(value) { pointer = value; } };
}

test('held post-publication health confirms native GUI and gated controller without promotion', async () => {
  const f = await fixture();
  const result = await f.run();
  assert.deepEqual(result, { state: 'published_healthy_unresolved', operation_id: f.operationId,
    generation: f.state.record.instance_id, registration_revision: hash(serializeManifestBytes({
      root: f.state.package.root, version: f.state.package.version, protocol: f.state.package.protocol })),
    journal_sha256: hash('published'), native_state: 'ready' });
  assert.equal(f.probes, 5);
  assert.equal(f.attachTickets, 0);
  assert.equal(f.state.published, false);
});

test('optional private transition callback receives proof only after health and it retires on return', async () => {
  let retired = false, received;
  const f = await fixture({ onProofRetired: () => { retired = true; } });
  await f.run({ afterVerified: ({ proof, health }) => {
    received = proof;
    assert.equal(f.probes, 5);
    assert.equal(health.state, 'published_healthy_unresolved');
    assert.equal(f.state.published, false);
  } });
  assert.deepEqual(received, {});
  assert.equal(retired, true);
  assert.equal(f.state.published, false);
});

test('private transition callback is refused after a failed health probe', async () => {
  let called = false;
  const f = await fixture({ spoofUi: true });
  await assert.rejects(f.run({ afterVerified: () => { called = true; } }), { code: 'nnd_activation_health_invalid' });
  assert.equal(called, false);
});

test('private transition proof retires when a callback throws or attempts asynchronous use', async () => {
  for (const afterVerified of [() => { throw Error('callback failed'); }, async () => {}]) {
    let retired = false;
    const f = await fixture({ onProofRetired: () => { retired = true; } });
    await assert.rejects(f.run({ afterVerified }), { code: 'nnd_activation_health_invalid' });
    assert.equal(retired, true);
    assert.equal(f.state.published, false);
  }
});

test('rejected asynchronous transition callback cannot crash the held owner later', async () => {
  const f = await fixture();
  let rejectLater;
  const pending = new Promise((_, reject) => { rejectLater = reject; });
  await assert.rejects(f.run({ afterVerified: () => pending }), { code: 'nnd_activation_health_invalid' });
  rejectLater(Error('late callback failure'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.state.published, false);
});

test('foreign receipt, pointer, child identity or registry never reaches health probes', async () => {
  for (const options of [{ foreignReceipt: true }, { foreignPointer: true },
    { reusedPid: true }, { foreignRegistration: true }, { closedController: true }, { closedNative: true }]) {
    const f = await fixture(options);
    await assert.rejects(f.run(), { code: 'nnd_activation_health_invalid' });
    assert.equal(f.state.published, false);
    assert.equal(f.attachTickets, 0);
  }
});

test('post-publication health refuses open attach, child death and changed evidence during probes', async () => {
  for (const options of [{ attachOpen: true }, { stopDuringProbe: true }, { badGui: true },
    { degraded: true }, { changeEvidenceDuringProbe: true }, { spoofUi: true }, { foreignUiKey: true }]) {
    const f = await fixture(options);
    await assert.rejects(f.run(), { code: 'nnd_activation_health_invalid' });
    assert.equal(f.state.published, false);
  }
});

test('changed durable journal or marker after publication blocks health success', async () => {
  const wrongJournal = await fixture();
  wrongJournal.journal[5].evidence_sha256 = hash('foreign');
  await assert.rejects(wrongJournal.run(), { code: 'nnd_activation_health_invalid' });
  assert.equal(wrongJournal.probes, 0);
  const wrongMarker = await fixture();
  const markerPath = join(wrongMarker.identity.data_root, 'runtime', 'nnd', 'installation-pending.json');
  wrongMarker.files.set(markerPath, json({ extra: true }));
  await assert.rejects(wrongMarker.run(), { code: 'nnd_activation_health_invalid' });
  assert.equal(wrongMarker.probes, 0);
});
