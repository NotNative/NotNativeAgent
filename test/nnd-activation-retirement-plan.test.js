// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, lstat, opendir, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ContractError } from '../src/ids.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value) + '\n');
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'nnd-retirement-plan-'));
  const options = { operationId: randomUUID(), stageOperationId: randomUUID(), generation: randomUUID() };
  const identity = { data_root: root, data_id: `data_${'a'.repeat(64)}`,
    installation_id: `nna_${'b'.repeat(64)}` };
  const serviceLease = {}, registryLease = {};
  const store = join(root, 'runtime', 'nnd', 'install-slots');
  const activations = join(store, 'activations');
  const directory = join(activations, options.operationId);
  await mkdir(directory, { recursive: true });
  const journal = Array.from({ length: 9 }, (_, index) => ({ phase: index === 8 ? 'completed' : 'earlier',
    receipt_sha256: hash(`receipt ${index}`) }));
  const marker = json({ protocol: '3.0', purpose: 'nnd_activation', operation_id: options.operationId,
    installation_id: identity.installation_id, data_id: identity.data_id,
    prepared_sha256: journal[0].receipt_sha256 });
  await writeFile(join(root, 'runtime', 'nnd', 'installation-pending.json'), marker);
  await writeFile(join(activations, `${options.operationId}.candidate.json`), 'candidate\n');
  await writeFile(join(activations, `${options.operationId}.child.json`), 'child\n');
  for (let index = 0; index < 9; index++) await writeFile(join(directory, `activation-0${index}.json`), `receipt ${index}\n`);
  const state = { identity, lease: serviceLease, retained: true, retainedLeaseArmed: true,
    stopping: false, published: false, child: { failed: false, child: { exitCode: null } },
    native: { isListening: () => true }, controller: { isListening: () => true },
    record: { instance_id: options.generation }, activationOperationId: options.operationId,
    stageOperationId: options.stageOperationId };
  const readInstallBytes = async (path, limit, optional = false) => {
    let bytes;
    try { bytes = await readFile(path); }
    catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
    if (bytes.length > limit) throw new Error('oversized');
    return bytes;
  };
  let failWrite = false;
  const writeInstallNew = async (path, bytes) => {
    const file = await open(path, 'wx');
    try { await file.writeFile(failWrite ? bytes.subarray(0, 12) : bytes); await file.sync(); }
    finally { await file.close(); }
    if (failWrite) throw new Error('interrupted write');
  };
  const source = await readFile(new URL('../src/nnd-activation-retirement-plan.js', import.meta.url), 'utf8');
  const executable = source.replace(/^import\s[\s\S]*?;\r?\n/gm, '')
    .replaceAll('export async function', 'async function');
  const dependencies = { lstat, opendir, join, resolve, ContractError,
    assertHeldNndServiceLease: lease => assert.equal(lease, serviceLease),
    withNndServiceLease: (_lease, _id, work) => work(new AbortController().signal),
    assertManifestLease: lease => { assert.equal(lease, registryLease);
      return { path: join(root, 'config', 'nnd-package.json') }; },
    runManifestLeaseWork: (_lease, work) => work(),
    readNndCompletionReceiptUnderOwnership: async () => ({ state: 'completion_recorded_barred',
      receipt_sha256: journal[8].receipt_sha256 }),
    readNndActivationJournal: async () => journal,
    openInstallStore: async () => ({}), readInstallBytes, writeInstallNew, hash, json,
    operationValid: value => [options.operationId, options.stageOperationId, options.generation].includes(value),
    exactRecord: (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) };
  const api = Function(...Object.keys(dependencies), `${executable}\nreturn {
    planNndTerminalRetirementUnderOwnership, readNndTerminalRetirementPlanUnderOwnership };`)(...Object.values(dependencies));
  return { root, identity, options, state,
    plan: () => api.planNndTerminalRetirementUnderOwnership(identity, state, serviceLease, registryLease, options),
    observe: () => api.readNndTerminalRetirementPlanUnderOwnership(identity, serviceLease, registryLease, options),
    planPath: join(store, 'activation-retirement.json'), directory,
    markerPath: join(root, 'runtime', 'nnd', 'installation-pending.json'),
    interruptWrite: () => { failWrite = true; }, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('terminal plan persists a barred intent without clearing marker or journal', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.observe()).state, 'unknown');
    const planned = await f.plan();
    assert.equal(planned.state, 'retirement_planned_barred');
    assert.equal((await f.observe()).plan_sha256, planned.plan_sha256);
    assert.ok((await lstat(f.markerPath)).isFile());
    assert.ok((await lstat(f.directory)).isDirectory());
    await assert.rejects(f.plan(), { code: 'nnd_activation_retirement_invalid' });
  } finally { await f.cleanup(); }
});

test('interrupted plan write and changed evidence fail closed with barrier intact', async () => {
  const f = await fixture();
  try {
    f.interruptWrite();
    await assert.rejects(f.plan(), { code: 'nnd_activation_retirement_invalid' });
    await assert.rejects(f.observe(), { code: 'nnd_activation_retirement_invalid' });
    assert.ok((await lstat(f.markerPath)).isFile());
  } finally { await f.cleanup(); }
  const g = await fixture();
  try {
    await g.plan();
    await writeFile(join(g.directory, 'activation-08.json'), 'changed\n');
    await assert.rejects(g.observe(), { code: 'nnd_activation_retirement_invalid' });
    assert.ok((await lstat(g.markerPath)).isFile());
  } finally { await g.cleanup(); }
});

test('dead retained owner cannot create terminal plan from historical completion', async () => {
  const f = await fixture();
  try {
    f.state.child.child.exitCode = 0;
    await assert.rejects(f.plan(), { code: 'nnd_activation_retirement_invalid' });
    await assert.rejects(lstat(f.planPath), { code: 'ENOENT' });
    assert.ok((await lstat(f.markerPath)).isFile());
  } finally { await f.cleanup(); }
});
