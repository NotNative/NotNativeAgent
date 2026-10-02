// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ContractError } from '../src/ids.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value) + '\n');
const identity = { install_root: 'C:\\native', data_root: 'C:\\data', installation_id: `nna_${sha('native')}`,
  data_id: `data_${sha('data')}`, platform: 'win32', architecture: 'x64', node_major: 24 };
const stageId = randomUUID(), activationId = randomUUID(), payloadSha = sha('inventory');
async function fixture() {
  const state = { marker: null, ready: null, journal: [], proof: null, payloadSha, packageVersion: '20261002-8',
    dropJournalOnVerify: false };
  const store = { pending: join(identity.data_root, 'runtime', 'nnd', 'installation-pending.json'),
    provenance: join(identity.data_root, 'runtime', 'nnd', 'install-slots', 'provenance') };
  const slot = join(identity.data_root, 'runtime', 'nnd', 'install-slots', 'versions', `20261002-8-${payloadSha}`);
  const transaction = { directory: join(identity.data_root, 'runtime', 'nnd', 'install-slots', 'transactions', stageId),
    slot, bytes: json({ stage: stageId }), record: { operation_id: stageId, version: '20261002-8',
      payload_sha256: payloadSha, reused_provenance: null } };
  state.ready = json({ protocol: '2.0', operation_id: stageId, prepared_sha256: sha(transaction.bytes), state: 'slot_ready' });
  state.proof = { bytes: json({ proven: true }), value: { version: '20261002-8', publication_id: stageId,
    ino: '10', dev: '20', bytes: 112 } };
  const lease = { held: true }, registry = { held: true };
  const entryPath = 'packages/electron/dist-server/server.mjs';
  const verified = { sha256: payloadSha, bytes: Buffer.alloc(12), manifest: { version: '20261002-8',
    files: [{ path: entryPath, bytes: 100, sha256: sha('entry') }] } };
  const dependencies = { createHash, join, realpath: async path => path, ContractError,
    assertHeldNndServiceLease: (value, dataId) => { if (value !== lease || !lease.held || dataId !== identity.data_id) throw new ContractError('nnd_lock_lost', 'lost'); },
    withNndServiceLease: async (_lease, _dataId, operation) => operation(new AbortController().signal),
    assertManifestLease: value => { if (value !== registry || !registry.held) throw new ContractError('manifest_lock_invalid', 'lost');
      return { path: join(identity.data_root, 'config', 'nnd-package.json') }; },
    runManifestLeaseWork: async (_registry, operation) => operation(),
    readLockedManifestSnapshot: async () => ({ revision: 'absent' }),
    openInstallStore: async () => store, readInstallBytes: async path => path === store.pending ? state.marker
      : path === join(transaction.directory, 'ready.json') ? state.ready : null,
    json, hash: sha, operationValid: value => /^[a-f0-9-]{36}$/u.test(value),
    loadInstallTransaction: async (_identity, _store, id) => { assert.equal(id, stageId); return transaction; },
    installHost: () => ({}), readSlotProvenance: async () => state.proof,
    slotOwner: async () => ({ ino: '10', dev: '20' }), assertNndInstallRuntimePaths: () => {},
    verifyNndPayload: async () => { if (state.dropJournalOnVerify) state.journal = [];
      return { ...verified, sha256: state.payloadSha }; },
    readPayloadBytes: async () => Buffer.from(JSON.stringify({ service_activation: { entrypoint: entryPath } })),
    validateNndPackage: async () => ({ root: slot, manifestPath: join(slot, 'nna-integration', 'nnd-local', 'integration.json'),
      version: state.packageVersion, protocol: '1.0' }),
    readNndActivationJournal: async () => state.journal,
    hasActivationInitialization: async () => false };
  const source = await readFile(new URL('../src/nnd-activation-candidate.js', import.meta.url), 'utf8');
  const executable = source.replace(/^import\s[\s\S]*?;\r?\n/gm, '').replaceAll('export async function', 'async function')
    .replaceAll('export function', 'function');
  const api = Function(...Object.keys(dependencies), executable + '\nreturn {readNndActivationCandidate,issueNndTrialCapability,consumeNndTrialCapability};')
    (...Object.values(dependencies));
  return { api, state, lease, registry, transaction, slot };
}
test('verified staged slot produces identity-bound evidence and no trial authority without preparation', async () => {
  const f = await fixture();
  const candidate = await f.api.readNndActivationCandidate(identity, f.lease, f.registry, stageId);
  assert.equal(candidate.package.entrypoint, join(f.slot, 'packages/electron/dist-server/server.mjs'));
  assert.equal(candidate.evidence.stage_ready_sha256, sha(f.state.ready));
  assert.equal(candidate.evidence.registry_before_revision, 'absent');
  assert.equal(candidate.evidence_sha256, sha(json(candidate.evidence)));
  await assert.rejects(f.api.issueNndTrialCapability(identity, f.lease, f.registry, stageId, activationId),
    { code: 'nnd_activation_candidate_invalid' });
});
test('prepared receipt and exact owned barrier mint one-use unpublished trial capability', async () => {
  const f = await fixture();
  const candidate = await f.api.readNndActivationCandidate(identity, f.lease, f.registry, stageId);
  f.state.journal = [{ phase: 'prepared', evidence_sha256: candidate.evidence_sha256, receipt_sha256: sha('prepared') }];
  f.state.marker = json({ protocol: '3.0', purpose: 'nnd_activation', operation_id: activationId,
    installation_id: identity.installation_id, data_id: identity.data_id, prepared_sha256: sha('prepared') });
  const token = await f.api.issueNndTrialCapability(identity, f.lease, f.registry, stageId, activationId);
  assert.deepEqual(Object.keys(token), []);
  await assert.rejects(f.api.issueNndTrialCapability(identity, f.lease, f.registry, stageId, activationId),
    { code: 'nnd_activation_candidate_invalid' });
  assert.equal(f.api.consumeNndTrialCapability(token, identity, f.lease, f.registry).entrypoint,
    join(f.slot, 'packages/electron/dist-server/server.mjs'));
  assert.throws(() => f.api.consumeNndTrialCapability(token, identity, f.lease, f.registry),
    { code: 'nnd_activation_candidate_invalid' });
});
test('changed slot, provenance, stage receipt, or marker blocks capability issuance', async () => {
  for (const change of [
    f => { f.state.payloadSha = sha('changed'); },
    f => { f.state.proof.value.ino = '11'; },
    f => { f.state.ready = json({ state: 'unpublished' }); },
    f => { f.state.marker = json({ foreign: true }); },
  ]) {
    const f = await fixture();
    const candidate = await f.api.readNndActivationCandidate(identity, f.lease, f.registry, stageId);
    f.state.journal = [{ phase: 'prepared', evidence_sha256: candidate.evidence_sha256, receipt_sha256: sha('prepared') }];
    f.state.marker = json({ protocol: '3.0', purpose: 'nnd_activation', operation_id: activationId,
      installation_id: identity.installation_id, data_id: identity.data_id, prepared_sha256: sha('prepared') });
    change(f);
    await assert.rejects(f.api.issueNndTrialCapability(identity, f.lease, f.registry, stageId, activationId));
  }
});
test('forged leases and wrong preparation digest cannot mint trial authority', async () => {
  const f = await fixture();
  await assert.rejects(f.api.readNndActivationCandidate(identity, {}, f.registry, stageId), { code: 'nnd_lock_lost' });
  const candidate = await f.api.readNndActivationCandidate(identity, f.lease, f.registry, stageId);
  f.state.journal = [{ phase: 'prepared', evidence_sha256: sha('different'), receipt_sha256: sha('prepared') }];
  f.state.marker = json({ protocol: '3.0', purpose: 'nnd_activation', operation_id: activationId,
    installation_id: identity.installation_id, data_id: identity.data_id, prepared_sha256: sha('prepared') });
  assert.notEqual(candidate.evidence_sha256, f.state.journal[0].evidence_sha256);
  await assert.rejects(f.api.issueNndTrialCapability(identity, f.lease, f.registry, stageId, activationId),
    { code: 'nnd_activation_candidate_invalid' });
});
test('prepared receipt removed during candidate verification cannot mint trial authority', async () => {
  const f = await fixture();
  const candidate = await f.api.readNndActivationCandidate(identity, f.lease, f.registry, stageId);
  f.state.journal = [{ phase: 'prepared', evidence_sha256: candidate.evidence_sha256, receipt_sha256: sha('prepared') }];
  f.state.marker = json({ protocol: '3.0', purpose: 'nnd_activation', operation_id: activationId,
    installation_id: identity.installation_id, data_id: identity.data_id, prepared_sha256: sha('prepared') });
  f.state.dropJournalOnVerify = true;
  await assert.rejects(f.api.issueNndTrialCapability(identity, f.lease, f.registry, stageId, activationId),
    { code: 'nnd_activation_candidate_invalid' });
});
