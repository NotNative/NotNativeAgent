// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, lstat, opendir, open, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ContractError } from '../src/ids.js';
import { hasActivationEvidence } from '../src/nnd-activation-initialization-db.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => Buffer.from(JSON.stringify(value) + '\n');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'nnd-retirement-decision-'));
  const options = { operationId: randomUUID(), stageOperationId: randomUUID(), generation: randomUUID() };
  const identity = { data_root: root, data_id: `data_${'a'.repeat(64)}`,
    installation_id: `nna_${'b'.repeat(64)}` };
  const serviceLease = {}, registryLease = {};
  const slots = join(root, 'runtime', 'nnd', 'install-slots');
  const activations = join(slots, 'activations');
  const directory = join(activations, options.operationId);
  await mkdir(directory, { recursive: true });
  const markerPath = join(root, 'runtime', 'nnd', 'installation-pending.json');
  const marker = json({ protocol: '3.0', purpose: 'nnd_activation', operation_id: options.operationId });
  await writeFile(markerPath, marker);
  const processIdentity = { version: 1, pid: 4242, platform: 'win32', start_id: '123456789' };
  const child = json({ protocol: '1.0', operation_id: options.operationId,
    installation_id: identity.installation_id, data_id: identity.data_id,
    generation: options.generation, version: '20261003-1', process_identity: processIdentity });
  const candidate = Buffer.from('candidate\n');
  await writeFile(join(activations, `${options.operationId}.candidate.json`), candidate);
  await writeFile(join(activations, `${options.operationId}.child.json`), child);
  const journalFiles = [];
  for (let index = 0; index < 9; index++) {
    const name = `activation-0${index}.json`, content = Buffer.from(`journal ${index}\n`);
    await writeFile(join(directory, name), content);
    journalFiles.push({ name, sha256: hash(content), present: true });
  }
  const stat = await lstat(directory);
  const plan = { protocol: '1.0', state: 'planned_barred', operation_id: options.operationId,
    stage_operation_id: options.stageOperationId, installation_id: identity.installation_id,
    data_id: identity.data_id, generation: options.generation, completion_sha256: hash('completion'),
    directory_ino: String(stat.ino), directory_dev: String(stat.dev), marker_sha256: hash(marker),
    files: [{ name: 'candidate.json', sha256: hash(candidate), present: true },
      { name: 'registration.before', sha256: null, present: false },
      { name: 'child.json', sha256: hash(child), present: true }, ...journalFiles] };
  const planBytes = json(plan), planPath = join(slots, 'activation-retirement.json');
  await writeFile(planPath, planBytes);
  const registration = Buffer.from('selected registration\n'), registrationRevision = hash(registration);
  let pointer = { instance_id: options.generation, data_id: identity.data_id };
  let partialWrite = false, loseResponse = false, removeAfterWrite = null;
  const state = { identity, lease: serviceLease, retained: true, retainedLeaseArmed: true,
    stopping: false, published: false, child: { failed: false, child: { exitCode: null, pid: 4242 } },
    native: { isListening: () => true }, controller: { isListening: () => true },
    record: pointer, activationOperationId: options.operationId, stageOperationId: options.stageOperationId };
  const source = await readFile(new URL('../src/nnd-activation-retirement-decision.js', import.meta.url), 'utf8');
  const executable = source.replace(/^import\s[\s\S]*?;\r?\n/gm, '')
    .replaceAll('export async function', 'async function');
  const dependencies = { lstat, opendir, join, resolve, isDeepStrictEqual, ContractError,
    assertHeldNndServiceLease: lease => assert.equal(lease, serviceLease),
    withNndServiceLease: (_lease, _id, work) => work(new AbortController().signal),
    assertManifestLease: lease => { assert.equal(lease, registryLease);
      return { path: join(root, 'config', 'nnd-package.json') }; },
    runManifestLeaseWork: (_lease, work) => work(),
    readLockedManifestSnapshot: async () => ({ rawBytes: registration, revision: registrationRevision }),
    readNndPrivateTicketReceiptUnderOwnership: async () => ({ state: 'private_ticket_recorded_unresolved',
      registration_revision: registrationRevision }),
    readNndTerminalRetirementPlanUnderOwnership: async () => ({ state: 'retirement_planned_barred',
      plan_sha256: hash(planBytes) }),
    parseNndTerminalRetirementPlanBytes: raw => JSON.parse(raw),
    readNndServiceDiscovery: async () => pointer,
    captureDiscoveryProcessIdentity: async () => processIdentity,
    openInstallStore: async () => ({}),
    readInstallBytes: async (path, limit, optional = false) => {
      let content;
      try { content = await readFile(path); }
      catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
      if (content.length > limit) throw Error('oversize');
      return content;
    },
    writeInstallNew: async (path, content) => {
      const handle = await open(path, 'wx');
      try { await handle.writeFile(partialWrite ? content.subarray(0, 12) : content); await handle.sync(); }
      finally { await handle.close(); }
      if (removeAfterWrite) await unlink(removeAfterWrite);
      if (partialWrite) throw Error('interrupted');
      if (loseResponse) throw Error('lost response after sync');
    },
    hash, json, operationValid: value => [options.operationId, options.stageOperationId, options.generation].includes(value),
    exactRecord: (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)),
    validIdentity: value => value?.version === 1 && Number.isSafeInteger(value.pid) && value.pid > 0,
  };
  const api = Function(...Object.keys(dependencies), `${executable}\nreturn {
    recordNndExternalRetirementDecisionUnderOwnership, readNndExternalRetirementDecisionUnderOwnership };`)(...Object.values(dependencies));
  return { root, identity, options, state, markerPath, directory, registrationRevision,
    decisionPath: join(slots, 'activation-retirement-decision.json'),
    record: () => api.recordNndExternalRetirementDecisionUnderOwnership(identity, state, serviceLease, registryLease, options),
    read: () => api.readNndExternalRetirementDecisionUnderOwnership(identity, serviceLease, registryLease, options),
    interruptWrite: () => { partialWrite = true; },
    loseWriteResponse: () => { loseResponse = true; },
    removeAfterDecisionWrite: path => { removeAfterWrite = path; },
    clearPointer: () => { pointer = null; },
    cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('external decision remains barred and reopens after journal deletion', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.read()).state, 'unknown');
    const result = await f.record();
    assert.equal(result.state, 'retirement_decision_recorded_barred');
    assert.equal(result.journal_state, 'complete');
    for (let index = 0; index < 9; index++) await unlink(join(f.directory, `activation-0${index}.json`));
    f.clearPointer();
    const reopened = await f.read();
    assert.equal(reopened.decision_sha256, result.decision_sha256);
    assert.equal(reopened.journal_state, 'absent');
    assert.equal(reopened.pointer_state, 'absent');
    assert.ok((await lstat(f.markerPath)).isFile());
    await unlink(join(f.root, 'runtime', 'nnd', 'install-slots', 'activations',
      `${f.options.operationId}.candidate.json`));
    await unlink(join(f.root, 'runtime', 'nnd', 'install-slots', 'activations',
      `${f.options.operationId}.child.json`));
    await unlink(f.markerPath);
    const later = await f.read();
    assert.equal(later.sidecar_state, 'absent');
    assert.equal(later.marker_state, 'absent');
    assert.equal(later.journal_state, 'absent');
    assert.equal(await hasActivationEvidence(f.root), true);
    await assert.rejects(f.record(), { code: 'nnd_activation_retirement_decision_invalid' });
  } finally { await f.cleanup(); }
});

test('interrupted decision and changed child evidence remain unresolved with marker intact', async () => {
  const f = await fixture();
  try {
    f.interruptWrite();
    await assert.rejects(f.record(), { code: 'nnd_activation_retirement_decision_invalid' });
    await assert.rejects(f.read(), { code: 'nnd_activation_retirement_decision_invalid' });
    assert.ok((await lstat(f.markerPath)).isFile());
  } finally { await f.cleanup(); }
  const g = await fixture();
  try {
    await g.record();
    await writeFile(join(g.root, 'runtime', 'nnd', 'install-slots', 'activations',
      `${g.options.operationId}.child.json`), 'changed\n');
    await assert.rejects(g.read(), { code: 'nnd_activation_retirement_decision_invalid' });
    assert.ok((await lstat(g.markerPath)).isFile());
  } finally { await g.cleanup(); }
});

test('lost decision write response is resolved only by exact independent readback', async () => {
  const f = await fixture();
  try {
    f.loseWriteResponse();
    await assert.rejects(f.record(), { code: 'nnd_activation_retirement_decision_invalid' });
    const reopened = await f.read();
    assert.equal(reopened.state, 'retirement_decision_recorded_barred');
    assert.equal(reopened.marker_state, 'present');
    assert.equal(reopened.journal_state, 'complete');
    assert.ok((await lstat(f.markerPath)).isFile());
  } finally { await f.cleanup(); }
});

test('writer does not claim a clean pre-retirement decision if evidence vanishes during publication', async () => {
  for (const suffix of ['marker', 'child']) {
    const f = await fixture();
    try {
      const path = suffix === 'marker' ? f.markerPath : join(f.root, 'runtime', 'nnd', 'install-slots',
        'activations', `${f.options.operationId}.child.json`);
      f.removeAfterDecisionWrite(path);
      await assert.rejects(f.record(), { code: 'nnd_activation_retirement_decision_invalid' });
      const historical = await f.read();
      assert.equal(historical.state, 'retirement_decision_recorded_barred');
      assert.equal(historical[suffix === 'marker' ? 'marker_state' : 'sidecar_state'],
        suffix === 'marker' ? 'absent' : 'partial');
      assert.equal(await hasActivationEvidence(f.root), true);
    } finally { await f.cleanup(); }
  }
});
