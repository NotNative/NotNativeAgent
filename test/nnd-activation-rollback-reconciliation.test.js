// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ContractError } from '../src/ids.js';
import { assertManifestLease, runManifestLeaseWork } from '../src/persistence/manifest-lock.js';
import { withManifestLock, readLockedManifestOperation, readLockedManifestSnapshot } from '../src/persistence/manifest-transaction.js';
import { validIdentity } from '../src/reliability/process-identity.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value) + '\n');
async function observer(dependencies) {
  const source = await readFile(new URL('../src/nnd-activation-rollback-reconciliation.js', import.meta.url), 'utf8');
  const executable = source.replace(/^import\s[\s\S]*?;\r?\n/gm, '').replaceAll('export async function', 'async function');
  return Function(...Object.keys(dependencies), executable + '\nreturn reconcileNndRollbackUnderOwnership;')
    (...Object.values(dependencies));
}
async function fixture(options = {}) {
  const operationId = randomUUID(), stageOperationId = randomUUID(), generation = randomUUID();
  const identity = { data_root: options.root ?? 'C:\\nna-rollback-reconcile-test',
    data_id: `data_${'b'.repeat(64)}`, installation_id: `nna_${'a'.repeat(64)}` };
  const serviceLease = {}, registryLease = {};
  const before = options.absent ? null : Buffer.from('{ malformed prior }\r\n');
  const beforeRevision = before === null ? 'absent' : hash(before);
  const desired = Buffer.from('{"protocol":"1.0","root":"C:\\\\slot","version":"20261003-1"}\n');
  const selectedRevision = hash(desired);
  const child = { protocol: '1.0', operation_id: operationId, installation_id: identity.installation_id,
    data_id: identity.data_id, generation, version: '20261003-1',
    process_identity: { version: 1, pid: 987654321, platform: 'win32', start_id: '123456789' } };
  const childBytes = json(child), childSha = hash(childBytes);
  const candidate = { evidence: { protocol: '2.0', stage_operation_id: stageOperationId,
    desired_registration_sha256: selectedRevision, registry_before_revision: beforeRevision,
    payload_sha256: hash('payload') },
    package: { version: child.version } };
  candidate.evidence_sha256 = hash(json(candidate.evidence));
  const base = join(identity.data_root, 'runtime', 'nnd');
  const activation = join(base, 'install-slots', 'activations');
  const journal = [{ phase: 'prepared', receipt_sha256: hash('prepared'), evidence_sha256: candidate.evidence_sha256 },
    { phase: 'trial_starting', receipt_sha256: hash('starting'), evidence_sha256: hash(json({
      operation_id: operationId, stage_operation_id: stageOperationId,
      installation_id: identity.installation_id, data_id: identity.data_id,
      version: child.version, payload_sha256: candidate.evidence.payload_sha256 })) },
    { phase: 'trial_running', receipt_sha256: hash('running'), evidence_sha256: hash(json({
      installation_id: identity.installation_id, data_id: identity.data_id, generation, version: child.version })) },
    { phase: 'trial_healthy', receipt_sha256: hash('healthy') }];
  if (options.forwardJournal !== false) journal.push({ phase: 'registration_cas', receipt_sha256: hash('forward'),
    evidence_sha256: hash(json({ operation_id: operationId, before_revision: beforeRevision,
      after_revision: selectedRevision, child_sha256: childSha })) });
  const previous = journal.at(-1).receipt_sha256;
  journal.push({ phase: 'rollback_pending', receipt_sha256: hash('pending'), evidence_sha256: hash(json({
    operation_id: operationId, stage_operation_id: stageOperationId, generation,
    before_revision: beforeRevision, selected_revision: selectedRevision, child_sha256: childSha,
    forward_receipt_revision: selectedRevision, journal_sha256: previous })) });
  if (options.complete) journal.push({ phase: 'rollback_complete', receipt_sha256: hash('complete'),
    evidence_sha256: hash(json({ operation_id: operationId, pending_sha256: hash('pending'),
      selected_revision: selectedRevision, restored_revision: beforeRevision,
      rollback_receipt_revision: beforeRevision })) });
  const marker = json({ protocol: '3.0', purpose: 'nnd_activation', operation_id: operationId,
    installation_id: identity.installation_id, data_id: identity.data_id, prepared_sha256: hash('prepared') });
  const files = new Map([[join(base, 'installation-pending.json'), marker],
    [join(activation, `${operationId}.candidate.json`), json(candidate.evidence)],
    [join(activation, `${operationId}.child.json`), childBytes]]);
  if (before !== null) files.set(join(activation, `${operationId}.registration.before`), before);
  let current = options.current === 'selected' ? desired : before;
  let rollback = options.rollback === 'missing' ? null : { operationId: `nnd-rollback-${operationId}`,
    persistence: options.rollback ?? 'saved', beforeRevision: selectedRevision,
    persistedRevision: options.rollback === 'unpublished' ? null : beforeRevision };
  const forward = { operationId: `nnd-activate-${operationId}`, persistence: 'saved',
    beforeRevision, persistedRevision: selectedRevision };
  let pointer = null, writes = 0, inspectedPid = 0;
  const dependencies = { join, resolve, ContractError, hash, json, validIdentity,
    operationValid: value => [operationId, stageOperationId, generation].includes(value),
    assertHeldNndServiceLease: lease => { if (lease !== serviceLease) throw Error('wrong singleton'); },
    withNndServiceLease: (_lease,_dataId,fn) => fn(new AbortController().signal),
    assertManifestLease: lease => { if (lease !== registryLease) throw Error('wrong mutex');
      return { path: join(identity.data_root, 'config', 'nnd-package.json') }; },
    runManifestLeaseWork: (_lease,fn) => fn(),
    readNndActivationJournal: async () => journal,
    readInstallBytes: async path => files.get(path) ?? null,
    readNndSelectedActivationCandidate: async (_identity,_service,_registry,stage,seenMarker,revision) => {
      assert.equal(stage,stageOperationId); assert.deepEqual(seenMarker,marker); assert.equal(revision,beforeRevision);
      return candidate; },
    readNndServiceDiscovery: async () => pointer,
    readLockedManifestOperation: async (_lease,id) => id === forward.operationId ? forward : rollback,
    readLockedManifestSnapshot: async () => ({ rawBytes: current, revision: current === null ? 'absent' : hash(current) }),
    exactRecord: (value,keys) => value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key)),
    captureDiscoveryProcessIdentity: async () => { inspectedPid++; throw Error('observer must not probe PID'); },
    transactLockedManifestBytes: async () => { writes++; throw Error('observer must not mutate'); },
    appendNndActivationPhase: async () => { writes++; throw Error('observer must not append'); } };
  const run = await observer(dependencies);
  return { run: () => run(identity,serviceLease,registryLease,{operationId}),
    makeRun: async overrides => {
      const real = await observer({ ...dependencies, ...overrides });
      return lease => real(identity, serviceLease, lease, { operationId });
    },
    identity,operationId,stageOperationId,generation,journal,files,marker,desired,before,
    get current(){return current;}, set current(value){current=value;},
    get rollback(){return rollback;}, set rollback(value){rollback=value;},
    get forward(){return forward;}, set pointer(value){pointer=value;},
    get writes(){return writes;}, get inspectedPid(){return inspectedPid;} };
}

for (const absent of [false,true]) for (const complete of [false,true])
  test(`saved rollback ${complete ? 'complete' : 'pending'} observes exact ${absent ? 'absence' : 'malformed CRLF prior'} without mutation`, async () => {
    const f=await fixture({absent,complete});
    assert.deepEqual(await f.run(), { state:'registration_restored_barrier_held', operation_id:f.operationId });
    assert.equal(f.writes,0);assert.equal(f.inspectedPid,0);
    assert.deepEqual(f.files.get(join(f.identity.data_root,'runtime','nnd','installation-pending.json')),f.marker);
  });
test('unpublished receipt with exact selected bytes is observation only; missing receipt is unknown', async () => {
  const unpublished=await fixture({rollback:'unpublished',current:'selected'});
  assert.equal((await unpublished.run()).state,'rollback_not_published_barrier_held');
  const missing=await fixture({rollback:'missing',current:'selected'});
  assert.equal((await missing.run()).state,'unknown');
  assert.equal(unpublished.writes+missing.writes,0);
});
test('foreign marker, child, journal, pointer, receipt, and current bytes fail closed', async () => {
  const cases = [
    f => f.files.delete(join(f.identity.data_root,'runtime','nnd','installation-pending.json')),
    f => { const path=[...f.files.keys()].find(key=>key.endsWith('.child.json')); f.files.set(path,Buffer.from('{broken')); },
    f => { f.journal[1].evidence_sha256=hash('foreign trial'); },
    f => { f.journal.at(-1).evidence_sha256=hash('foreign'); },
    f => { f.pointer={instance_id:randomUUID()}; },
    f => { f.rollback.beforeRevision=hash('foreign'); },
    f => { f.current=Buffer.from('foreign'); },
  ];
  for (const mutate of cases) {
    const f=await fixture();mutate(f);
    assert.equal((await f.run()).state,'unknown');
    assert.equal(f.writes,0);assert.equal(f.inspectedPid,0);
  }
});

for (const absent of [false,true]) test(`process death after raw rollback CAS observes ${absent ? 'absence' : 'exact malformed prior'} without writing`,
  { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
    const root=await mkdtemp(join(homedir(),'nna-rollback-observer-'));
    t.after(() => rm(root,{recursive:true,force:true}));
    await mkdir(join(root,'config'));
    const f=await fixture({root,absent});
    const path=join(root,'config','nnd-package.json');
    await writeFile(path,f.desired);
    const transaction=new URL('../src/persistence/manifest-transaction.js',import.meta.url).href;
    const script=`import {withManifestLock,transactLockedManifestBytes} from ${JSON.stringify(transaction)};
      await withManifestLock(process.argv[1],{},async lease=>{
        await transactLockedManifestBytes(lease,{expectedRevision:process.argv[2],operationId:process.argv[3],
          payload:{action:'crash-after-rollback-cas'},bytes:process.argv[4]==='absent'?null:Buffer.from(process.argv[4],'base64')});
        process.exit(71);
      });`;
    const child=spawnSync(process.execPath,['--input-type=module','-e',script,path,hash(f.desired),
      `nnd-rollback-${f.operationId}`,f.before===null?'absent':f.before.toString('base64')],
    {windowsHide:true,encoding:'utf8',timeout:15000});
    assert.equal(child.status,71,child.stderr);
    const run=await f.makeRun({ assertManifestLease,runManifestLeaseWork,readLockedManifestSnapshot,
      readLockedManifestOperation: (lease,id) => id===`nnd-activate-${f.operationId}`
        ? f.forward : readLockedManifestOperation(lease,id) });
    await withManifestLock(path,{},async lease => {
      assert.deepEqual(await run(lease),{state:'registration_restored_barrier_held',operation_id:f.operationId});
    });
    assert.equal(f.writes,0);assert.equal(f.inspectedPid,0);
    if (f.before===null) await assert.rejects(readFile(path),{code:'ENOENT'});
    else assert.deepEqual(await readFile(path),f.before);
  });
