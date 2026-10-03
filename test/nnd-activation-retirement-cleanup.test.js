// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, lstat, opendir, unlink, rmdir, rm, rename, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ContractError } from '../src/ids.js';
import { readInstallBytes, writeInstallNew, hash, json, operationValid } from '../src/nnd-install-storage.js';
import { noLinks } from '../src/nnd-payload-contract-files.js';
import { exactRecord } from '../src/nnd-service-contract.js';
import { validIdentity } from '../src/reliability/process-identity.js';
import { parseNndTerminalRetirementPlanBytes } from '../src/nnd-activation-retirement-plan.js';
import { runPrivateWindowsProgram, PRIVATE_ACL_PROGRAM } from '../src/nnd-service-private-windows.js';
import { hasActivationEvidence } from '../src/nnd-activation-initialization-db.js';

async function load(name, dependencies, exports) {
  const source = await readFile(new URL(`../src/${name}.js`, import.meta.url), 'utf8');
  const executable = source.replace(/^import\s[\s\S]*?;\r?\n/gm, '')
    .replaceAll('export async function', 'async function').replaceAll('export function', 'function');
  return Function(...Object.keys(dependencies), `${executable}\nreturn {${exports.join(',')}};`)(...Object.values(dependencies));
}
async function fixture({ nativeAcl = false } = {}) {
  const root = nativeAcl ? join(homedir(), `nnd-cleanup-acl-${randomUUID()}`)
    : await mkdtemp(join(tmpdir(), 'nnd-cleanup-'));
  const options = { operationId: randomUUID(), stageOperationId: randomUUID(), generation: randomUUID() };
  const identity = { data_root: root, data_id: `data_${'a'.repeat(64)}`, installation_id: `nna_${'b'.repeat(64)}` };
  const serviceLease = {}, registryLease = {};
  const placeRoot = join(root, 'runtime', 'nnd', 'install-slots');
  const activations = join(placeRoot, 'activations'), directory = join(activations, options.operationId);
  if (nativeAcl) {
    await runPrivateWindowsProgram(`${PRIVATE_ACL_PROGRAM}
      try {
        $r=[Console]::In.ReadToEnd()|ConvertFrom-Json
        Assert-Ancestors ([IO.Path]::GetDirectoryName($r.directories[0]))
        foreach($p in $r.directories) { Create-PrivateDirectory $p }
        [Console]::Out.WriteLine('{"ok":true}')
      } catch { [Console]::Out.WriteLine('{"error_code":"nnd_private_storage_unavailable"}'); exit 1 }`,
    { directories: [root, join(root, 'runtime'), join(root, 'runtime', 'nnd'), placeRoot, activations, directory] });
  } else await mkdir(directory, { recursive: true });
  const marker = Buffer.from('pending\n'), registration = Buffer.from('registration\n');
  const markerPath = join(root, 'runtime', 'nnd', 'installation-pending.json');
  await writeFile(markerPath, marker);
  const childIdentity = { version: 1, pid: 4242, platform: 'win32', start_id: '123456789' };
  const child = json({ protocol: '1.0', operation_id: options.operationId, installation_id: identity.installation_id,
    data_id: identity.data_id, generation: options.generation, version: '20261003-1', process_identity: childIdentity });
  const files = [];
  for (const [name, content] of [['candidate.json', Buffer.from('candidate\n')], ['registration.before', Buffer.from('before\n')],
    ['child.json', child], ...Array.from({ length: 9 }, (_, index) => [`activation-0${index}.json`, Buffer.from(`journal${index}\n`)])]) {
    await writeFile(name.startsWith('activation-') ? join(directory, name) : join(activations, `${options.operationId}.${name}`), content);
    files.push({ name, present: true, sha256: hash(content) });
  }
  const stat = await lstat(directory);
  const plan = { protocol: '1.0', state: 'planned_barred', operation_id: options.operationId,
    stage_operation_id: options.stageOperationId, installation_id: identity.installation_id, data_id: identity.data_id,
    generation: options.generation, completion_sha256: hash('completion'), directory_ino: String(stat.ino),
    directory_dev: String(stat.dev), marker_sha256: hash(marker), files };
  const planBytes = json(plan), planPath = join(placeRoot, 'activation-retirement.json');
  await writeFile(planPath, planBytes);
  let pointer = { instance_id: options.generation, data_id: identity.data_id }, registrationBytes = registration;
  const decision = { protocol: '1.0', state: 'decided_barred', operation_id: options.operationId,
    stage_operation_id: options.stageOperationId, installation_id: identity.installation_id, data_id: identity.data_id,
    generation: options.generation, plan_sha256: hash(planBytes), completion_sha256: plan.completion_sha256,
    marker_sha256: hash(marker), candidate_sha256: files[0].sha256, registration_before_sha256: files[1].sha256,
    child_sha256: files[2].sha256, registration_revision: hash(registration),
    registration_operation_id: `nnd-activate-${options.operationId}`, discovery_sha256: hash(json(pointer)), child_process_identity: childIdentity };
  const decisionPath = join(placeRoot, 'activation-retirement-decision.json');
  await writeFile(decisionPath, json(decision));
  const terminalPath = join(placeRoot, 'activation-retirement-commit.json');
  const state = { identity, lease: serviceLease, unpublishedTrial: true, retained: true, retainedLeaseArmed: true,
    stopping: false, published: false, child: { failed: false, child: { pid: 4242, exitCode: null } },
    native: { isListening: () => true }, controller: { isListening: () => true }, record: pointer,
    activationOperationId: options.operationId, stageOperationId: options.stageOperationId };
  const dependencies = { join, resolve, isDeepStrictEqual, ContractError, lstat, opendir, readInstallBytes, hash, json,
    operationValid, exactRecord, validIdentity, parseNndTerminalRetirementPlanBytes,
    assertHeldNndServiceLease: lease => assert.equal(lease, serviceLease),
    assertManifestLease: lease => { assert.equal(lease, registryLease); return { path: join(root, 'config', 'nnd-package.json') }; },
    withNndServiceLease: (_lease, _id, work) => work(new AbortController().signal),
    runManifestLeaseWork: (_lease, work) => work(), openInstallStore: async () => ({}),
    readLockedManifestSnapshot: async () => ({ revision: hash(registrationBytes), rawBytes: registrationBytes }),
    captureDiscoveryProcessIdentity: async () => childIdentity, readNndServiceDiscovery: async () => pointer };
  const decisionApi = await load('nnd-activation-retirement-decision', dependencies, ['readNndExternalRetirementDecisionUnderOwnership']);
  let removed = 0, interruptAt = null, afterRemoval = null, deniedAcl = false, afterCommitWrite = null;
  let barrierRemoved = 0, barrierInterrupt = null, afterBarrierRemoval = null;
  const remove = operation => async path => {
    await operation(path); removed++;
    if (afterRemoval) await afterRemoval();
    if (removed === interruptAt) throw Error('simulated death after durable filesystem prefix');
  };
  const fileApi = await load('nnd-activation-retirement-cleanup-files', { ...dependencies, noLinks,
    unlink: remove(unlink), rmdir: remove(rmdir), PRIVATE_ACL_PROGRAM: nativeAcl ? PRIVATE_ACL_PROGRAM : '', runPrivateWindowsProgram: nativeAcl ? runPrivateWindowsProgram : async () => {
      if (deniedAcl) throw Error('private ownership rejected'); return { ok: true };
    } },
  ['retirementCleanupPaths', 'inspectRetirementArtifacts', 'removeRetirementArtifact', 'assertRetirementBarrierAcl']);
  const api = await load('nnd-activation-retirement-cleanup', { ...dependencies, ...decisionApi, ...fileApi,
    noLinks, unlink: async path => { await unlink(path); barrierRemoved++; await afterBarrierRemoval?.();
      if (barrierRemoved === barrierInterrupt) throw Error('simulated death after barrier removal'); },
    writeInstallNew: async (path, content) => { await writeInstallNew(path, content); await afterCommitWrite?.(); } },
  ['cleanupNndRetirementEvidenceUnderOwnership', 'recordNndTerminalRetirementCommitUnderOwnership',
    'clearNndRetirementBarriersUnderOwnership']);
  return { root, activations, directory, markerPath, planPath, decisionPath, terminalPath, files, options, state,
    run: () => api.cleanupNndRetirementEvidenceUnderOwnership(identity, state, serviceLease, registryLease, options),
    commit: () => api.recordNndTerminalRetirementCommitUnderOwnership(identity, state, serviceLease, registryLease, options),
    clear: () => api.clearNndRetirementBarriersUnderOwnership(identity, state, serviceLease, registryLease, options),
    clearedPath: join(placeRoot, 'activation-retirement-cleared.json'),
    interruptBarrier: count => { barrierInterrupt = count; }, barrierRemoved: () => barrierRemoved,
    mutateAfterBarrierRemoval: fn => { afterBarrierRemoval = fn; },
    interrupt: count => { interruptAt = count; }, removed: () => removed,
    mutateAfterRemoval: fn => { afterRemoval = fn; }, clearPointer: () => { pointer = null; },
    afterCommitWrite: fn => { afterCommitWrite = fn; },
    changeRegistration: () => { registrationBytes = Buffer.from('foreign'); },
    denyAcl: () => { deniedAcl = true; },
    cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('every completed deletion prefix resumes with all three barriers and unrelated slot evidence intact', async () => {
  for (let prefix = 1; prefix <= 13; prefix++) {
    const f = await fixture();
    try {
      const unrelated = join(f.root, 'runtime', 'nnd', 'install-slots', 'stage-receipt-sentinel');
      await writeFile(unrelated, 'preserve');
      f.interrupt(prefix);
      await assert.rejects(f.run(), { code: 'nnd_activation_retirement_cleanup_invalid' });
      f.interrupt(null);
      assert.equal((await f.run()).state, 'retirement_evidence_cleaned_barred');
      assert.equal((await f.run()).state, 'retirement_evidence_cleaned_barred');
      assert.equal(f.removed(), 13);
      for (const path of [f.markerPath, f.planPath, f.decisionPath]) assert.ok((await lstat(path)).isFile());
      assert.equal(await readFile(unrelated, 'utf8'), 'preserve');
      assert.equal(f.state.published, false);
    } finally { await f.cleanup(); }
  }
});
test('changed last journal, unknown entry, replaced directory, or changed sidecar preserves the whole set', async () => {
  for (const mutate of [
    f => writeFile(join(f.directory, 'activation-08.json'), 'foreign'),
    f => writeFile(join(f.directory, 'foreign.json'), 'foreign'),
    f => writeFile(join(f.activations, `${f.options.operationId}.unknown`), 'foreign'),
    async f => { await rename(f.directory, `${f.directory}-old`); await mkdir(f.directory); },
    f => writeFile(join(f.activations, `${f.options.operationId}.child.json`), 'foreign'),
    f => link(join(f.directory, 'activation-08.json'), join(f.root, 'outside-hardlink')),
    async f => { f.denyAcl(); },
  ]) {
    const f = await fixture();
    try { await mutate(f); await assert.rejects(f.run()); assert.equal(f.removed(), 0); }
    finally { await f.cleanup(); }
  }
});
test('cancellation after one deletion preserves remaining evidence and all barriers', async () => {
  const f = await fixture();
  try {
    const controller = new AbortController(); f.options.signal = controller.signal;
    f.mutateAfterRemoval(() => controller.abort());
    await assert.rejects(f.run()); assert.equal(f.removed(), 1);
    assert.ok((await lstat(f.markerPath)).isFile());
  } finally { await f.cleanup(); }
});
test('second cleanup on the same lease is refused while underlying filesystem work remains pending', async () => {
  const f = await fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let observed;
  const entered = new Promise(resolve => { observed = resolve; });
  try {
    f.mutateAfterRemoval(async () => { observed(); await gate; });
    const first = f.run();
    await entered;
    await assert.rejects(f.run(), { code: 'nnd_activation_retirement_cleanup_invalid' });
    release();
    assert.equal((await first).state, 'retirement_evidence_cleaned_barred');
  } finally { release(); await f.cleanup(); }
});
test('loss of registration, selected pointer, or retained owner stops the next deletion', async () => {
  for (const invalidate of [f => f.changeRegistration(), f => f.clearPointer(), f => { f.state.stopping = true; }]) {
    const f = await fixture();
    try {
      f.mutateAfterRemoval(() => invalidate(f));
      await assert.rejects(f.run());
      assert.equal(f.removed(), 1);
      assert.ok((await lstat(f.markerPath)).isFile());
    } finally { await f.cleanup(); }
  }
});
test('missing external authority or marker cannot authorize a first deletion', async () => {
  for (const field of ['decisionPath', 'planPath', 'markerPath']) {
    const f = await fixture();
    try { await unlink(f[field]); await assert.rejects(f.run()); assert.equal(f.removed(), 0); }
    finally { await f.cleanup(); }
  }
});
test('Windows private ACL verifier accepts exact cleanup and retains all admission barriers',
  { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
    const f = await fixture({ nativeAcl: true });
    try {
      assert.equal((await f.run()).state, 'retirement_evidence_cleaned_barred');
      assert.equal(f.removed(), 13);
      for (const path of [f.markerPath, f.planPath, f.decisionPath]) assert.ok((await lstat(path)).isFile());
    } finally { await f.cleanup(); }
  });

test('terminal commit requires exact completed cleanup and remains barred after a canonical single write', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.commit(), { code: 'nnd_activation_retirement_cleanup_invalid' });
    await assert.rejects(lstat(f.terminalPath), { code: 'ENOENT' });
    await f.run();
    const result = await f.commit();
    assert.equal(result.state, 'terminal_committed_barred');
    const bytes = await readFile(f.terminalPath);
    const committed = JSON.parse(bytes.toString('utf8'));
    assert.equal(hash(bytes), result.commit_sha256);
    assert.equal(committed.marker_sha256, hash(await readFile(f.markerPath)));
    assert.equal(committed.decision_sha256, hash(await readFile(f.decisionPath)));
    assert.equal(committed.registration_revision.length, 64);
    assert.equal(f.state.published, false);
    await assert.rejects(f.commit(), { code: 'nnd_activation_retirement_cleanup_invalid' });
    assert.deepEqual(await readFile(f.terminalPath), bytes);
    for (const path of [f.markerPath, f.planPath, f.decisionPath]) assert.ok((await lstat(path)).isFile());
  } finally { await f.cleanup(); }
});

test('uncertain terminal write is preserved, never retried or treated as published', async () => {
  const f = await fixture();
  try {
    await f.run();
    f.afterCommitWrite(() => { throw Error('lost response after durable write'); });
    await assert.rejects(f.commit(), { code: 'nnd_activation_retirement_cleanup_invalid' });
    const bytes = await readFile(f.terminalPath);
    f.afterCommitWrite(null);
    await assert.rejects(f.commit(), { code: 'nnd_activation_retirement_cleanup_invalid' });
    assert.deepEqual(await readFile(f.terminalPath), bytes);
    assert.ok((await lstat(f.markerPath)).isFile());
  } finally { await f.cleanup(); }
});

test('a lone terminal commit remains an ordinary admission barrier after earlier proofs vanish', async () => {
  const f = await fixture();
  try {
    await f.run();
    await f.commit();
    await unlink(f.markerPath);
    await unlink(f.planPath);
    await unlink(f.decisionPath);
    assert.equal(await hasActivationEvidence(f.root), true);
  } finally { await f.cleanup(); }
});

test('changed live evidence prevents terminal commit after cleanup', async () => {
  for (const change of [f => f.clearPointer(), f => f.changeRegistration(), f => { f.state.stopping = true; },
    f => writeFile(f.markerPath, 'foreign')]) {
    const f = await fixture();
    try {
      await f.run(); await change(f);
      await assert.rejects(f.commit(), { code: 'nnd_activation_retirement_cleanup_invalid' });
      await assert.rejects(lstat(f.terminalPath), { code: 'ENOENT' });
    } finally { await f.cleanup(); }
  }
});

test('barrier clearance records witness before removal and resumes each crash prefix while admission stays barred', async () => {
  for (let prefix = 1; prefix <= 3; prefix++) {
    const f = await fixture();
    try {
      await f.run(); await f.commit();
      f.interruptBarrier(prefix);
      await assert.rejects(f.clear(), { code: 'nnd_activation_retirement_cleanup_invalid' });
      const witness = await readFile(f.clearedPath);
      assert.equal(JSON.parse(witness).state, 'barriers_cleared_admission_barred');
      assert.equal(await hasActivationEvidence(f.root), true);
      f.interruptBarrier(null);
      const result = await f.clear();
      assert.equal(result.state, 'barriers_cleared_admission_barred');
      assert.equal(f.barrierRemoved(), 3);
      assert.equal(await hasActivationEvidence(f.root), true);
      assert.equal((await f.clear()).witness_sha256, hash(witness));
      for (const path of [f.markerPath, f.planPath, f.decisionPath])
        await assert.rejects(lstat(path), { code: 'ENOENT' });
      assert.ok((await lstat(f.terminalPath)).isFile());
      assert.equal(f.state.published, false);
    } finally { await f.cleanup(); }
  }
});

test('barrier clearance rejects premature, foreign, and owner-lost evidence without further deletion', async () => {
  for (const mutate of [
    async f => {},
    async f => { await f.run(); await f.commit(); await writeFile(f.markerPath, 'foreign'); },
    async f => { await f.run(); await f.commit(); f.clearPointer(); },
    async f => { await f.run(); await f.commit(); f.changeRegistration(); },
    async f => { await f.run(); await f.commit(); f.state.stopping = true; },
    async f => { await f.run(); await f.commit(); await writeFile(join(f.activations, 'foreign'), 'foreign'); },
  ]) {
    const f = await fixture();
    try {
      await mutate(f);
      await assert.rejects(f.clear());
      assert.equal(f.barrierRemoved(), 0);
    } finally { await f.cleanup(); }
  }
});

test('witness write uncertainty preserves bytes and permits only exact live-owner recovery', async () => {
  const f = await fixture();
  try {
    await f.run(); await f.commit();
    f.afterCommitWrite(() => { throw Error('lost witness write response'); });
    await assert.rejects(f.clear(), { code: 'nnd_activation_retirement_cleanup_invalid' });
    const bytes = await readFile(f.clearedPath);
    f.afterCommitWrite(null);
    f.clearPointer();
    await assert.rejects(f.clear());
    assert.deepEqual(await readFile(f.clearedPath), bytes);
    assert.equal(f.barrierRemoved(), 0);
  } finally { await f.cleanup(); }
});

test('a lone cleared witness remains an ordinary startup barrier', async () => {
  const f = await fixture();
  try {
    await f.run(); await f.commit(); await f.clear();
    await unlink(f.terminalPath);
    assert.equal(await hasActivationEvidence(f.root), true);
  } finally { await f.cleanup(); }
});
