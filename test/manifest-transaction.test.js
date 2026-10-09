// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, chmod, link } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { transactManifest, readManifestSnapshot, withManifestLock, readLockedManifestSnapshot, readManifestOperation, readLockedManifestOperation, transactLockedManifest } from '../src/persistence/manifest-transaction.js';
import { serializeManifestBytes } from '../src/persistence/manifest-files.js';
import { runPrivateWindowsProgram } from '../src/nnd-service-private-windows.js';

async function fixture(t) {
  const parent = process.platform === 'win32' ? process.env.USERPROFILE : tmpdir();
  const root = await mkdtemp(join(parent, 'nna-manifest-test-'));
  t.after(async () => { assert.ok(root.startsWith(join(parent, 'nna-manifest-test-'))); await rm(root,{recursive:true,force:true}); });
  return join(root,'manifest.json');
}
const validate = (value) => { assert.equal(typeof value, 'object'); };
const request = (path, revision, id, value) => ({ path, expectedRevision: revision, operationId: id,
  payload: value, transform: () => value, validate });

test('byte revision publication is idempotent and leaves raw cached document unchanged', async t => {
  const path = await fixture(t);
  const initial = await readManifestSnapshot(path); assert.equal(initial.revision,'absent');
  const input = request(path,'absent','create',{ first:1, nested:{ keep:true } });
  const result = await transactManifest(input); assert.equal(result.persistence,'saved');
  assert.equal((await transactManifest(input)).replayed,true);
  await assert.rejects(transactManifest({...input,payload:{different:true}}),{code:'manifest_operation_conflict'});
  const snapshot = await readManifestSnapshot(path);
  assert.deepEqual(snapshot.rawBytes, serializeManifestBytes(input.payload));
  await transactManifest({...request(path,snapshot.revision,'edit',{ first:2 }),transform: raw => {raw.first=2;return raw;}});
  assert.equal(snapshot.rawManifest.first,1);
  assert.equal((await readManifestSnapshot(path)).rawManifest.nested.keep,true);
  await assert.rejects(transactManifest(request(path,snapshot.revision,'stale',{})),{code:'manifest_revision_conflict'});
  await assert.rejects(transactManifest({...input,expectedRevision:undefined}),{code:'manifest_request_invalid'});
});
test('malformed bytes are preserved for an explicit validated repair',async t=>{
  const path=await fixture(t);await writeFile(path,'{broken-secret-input');
  const before=await readManifestSnapshot(path);assert.equal(before.rawManifest,null);
  await transactManifest(request(path,before.revision,'repair',{ repaired:true }));
  assert.deepEqual((await readManifestSnapshot(path)).rawManifest,{repaired:true});
  await assert.rejects(readLockedManifestSnapshot({}),{code:'manifest_lock_invalid'});
});
test('abort keeps lease until callback work settles and prevents publication',async t=>{
  const path=await fixture(t);const controller=new AbortController();let release, entered;
  const started=new Promise(resolve=>{entered=resolve;});
  const blocked=new Promise(resolve=>{release=resolve;});
  const pending=transactManifest({...request(path,'absent','cancel',{}),signal:controller.signal,
    transform:async()=>{entered();await blocked;return {};}});
  await started;controller.abort();
  await assert.rejects(withManifestLock(path,{timeoutMs:40},async()=>{}),{code:'manifest_lock_busy'});
  release();await assert.rejects(pending);assert.equal((await readManifestSnapshot(path)).revision,'absent');
  await transactManifest(request(path,'absent','after-cancel',{}));
});
test('SQLite ownership releases after actual child process death',async t=>{
  const path=await fixture(t);const module=new URL('../src/persistence/manifest-transaction.js',import.meta.url).href;
  const source=`import {withManifestLock} from ${JSON.stringify(module)}; await withManifestLock(${JSON.stringify(path)},{},async()=>{process.stdout.write('held\\n');setInterval(()=>{},1000);await new Promise(()=>{});});`;
  const child=spawn(process.execPath,['--input-type=module','-e',source],{windowsHide:true,stdio:['ignore','pipe','ignore']});
  t.after(()=>child.kill());await once(child.stdout,'data');
  await assert.rejects(withManifestLock(path,{timeoutMs:40},async()=>{}),{code:'manifest_lock_busy'});
  const exit=once(child,'exit');child.kill();await exit;
  await transactManifest(request(path,'absent','after-crash',{}));
});
test('hardlinked manifests are refused rather than splitting ownership',async t=>{
  const path=await fixture(t);await writeFile(path,'{}');await link(path,path+'.alias');
  await assert.rejects(readManifestSnapshot(path),{code:'manifest_target_unsafe'});
});
test('Windows manifest admission reports an unavailable ACL helper separately from an unsafe target',
  {skip:process.platform!=='win32'}, async t=>{
    const path=await fixture(t),module=new URL('../src/persistence/manifest-files.js',import.meta.url).href;
    const source=`import {manifestTarget} from ${JSON.stringify(module)};
      process.env.SystemRoot=${JSON.stringify(join(path,'missing-windows-root'))};
      try { await manifestTarget(${JSON.stringify(path)}); process.stdout.write('admitted'); }
      catch(error) { process.stdout.write(error.code ?? 'unknown'); }`;
    const result=spawnSync(process.execPath,['--input-type=module','-e',source],
      {encoding:'utf8',timeout:5000});
    assert.equal(result.status,0,result.stderr);
    assert.equal(result.stdout,'manifest_target_unavailable');
  });

test('Windows private helper preserves a bounded check stage without treating an unknown error as unsafe',
  {skip:process.platform!=='win32'}, async()=>{
    await assert.rejects(runPrivateWindowsProgram(String.raw`
      [Console]::Out.WriteLine('{"error_code":"unexpected_error","check_stage":"manifest_file"}')
      exit 1
    `, {}), error=>error.code==='nnd_private_storage_unavailable' && error.checkStage==='manifest_file');
    await assert.rejects(runPrivateWindowsProgram(String.raw`
      [Console]::Out.WriteLine('{"error_code":"nnd_private_acl_unsafe","check_stage":"untrusted_stage"}')
      exit 1
    `, {}), error=>error.code==='nnd_private_acl_unsafe' && error.checkStage===undefined);
  });

for (const phase of ['before','after','foreign']) test(`prepared operation crash reconciles ${phase} publication`,async t=>{
  const path=await fixture(t);await writeFile(path,'{"before":true}\n');
  const base=new URL('../src/persistence/',import.meta.url).href;
  const source=`import {withManifestLock,assertManifestLease} from ${JSON.stringify(base+'manifest-lock.js')};
    import {readTargetSnapshot,digest,stageManifest,publishManifest} from ${JSON.stringify(base+'manifest-files.js')};
    import {openManifestReceipts,prepareManifestReceipt} from ${JSON.stringify(base+'manifest-receipts.js')};
    await withManifestLock(${JSON.stringify(path)},{},async lease=>{
      const target=assertManifestLease(lease),before=await readTargetSnapshot(target),bytes=Buffer.from('{"after":true}\\n');
      const staged=await stageManifest(target,bytes),db=await openManifestReceipts(lease);
      prepareManifestReceipt(db,{id:'interrupted',payloadHash:digest('payload'),before:before.revision,after:digest(bytes),backup:null});
      if(${JSON.stringify(phase)}==='after') await publishManifest(target,staged,false);
      process.stdout.write('prepared');setInterval(()=>{},1000);await new Promise(()=>{});
    });`;
  const child=spawn(process.execPath,['--input-type=module','-e',source],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  t.after(()=>child.kill());await once(child.stdout,'data');
  const exited=once(child,'exit');child.kill();await exited;
  if(phase==='foreign') {
    await writeFile(path,'{"foreign":true}');
    await assert.rejects(readManifestOperation(path,'interrupted'),{code:'manifest_receipt_ambiguous',persistence:'unknown'});
    const current=await readManifestSnapshot(path);
    await assert.rejects(transactManifest(request(path,current.revision,'blocked',{})),{code:'manifest_receipt_ambiguous'});
  } else assert.equal((await readManifestOperation(path,'interrupted')).persistence,phase==='after'?'saved':'unpublished');
});

test('terminal receipt retention permits ongoing edits and bounds the replay window', {timeout:30000}, async t => {
  const path=await fixture(t);
  await withManifestLock(path, {}, async lease => {
    let revision='absent';
    for(let i=0;i<130;i++) {
      const result=await transactLockedManifest(lease, request(path,revision,`edit-${i}`,{i}));
      assert.equal(result.replayWindow,'last_128_operations'); revision=result.persistedRevision;
    }
    assert.equal((await readLockedManifestSnapshot(lease)).rawManifest.i,129);
  });
  assert.equal(await readManifestOperation(path,'edit-0'),null);
  assert.equal((await readManifestOperation(path,'edit-129')).persistence,'saved');
});
test('locked snapshots reject expired leases', async t=>{
  const path=await fixture(t);let captured;
  await withManifestLock(path,{},async lease=>{captured=lease;});
  await assert.rejects(readLockedManifestSnapshot(captured),{code:'manifest_lock_invalid'});
});
test('held owner can reconcile its manifest receipt without reacquiring the mutex', async t => {
  const path = await fixture(t);
  await withManifestLock(path, {}, async lease => {
    assert.equal(await readLockedManifestOperation(lease, 'missing'), null);
    const result = await transactLockedManifest(lease, request(path, 'absent', 'activation-cas', { selected: true }));
    const receipt = await readLockedManifestOperation(lease, 'activation-cas');
    assert.equal(receipt.persistence, 'saved');
    assert.equal(receipt.beforeRevision, 'absent');
    assert.equal(receipt.persistedRevision, result.persistedRevision);
  });
});

test('crash after initial publication link recovers only its prepared stage', {timeout:15000}, async t=>{
  const path=await fixture(t), base=new URL('../src/persistence/',import.meta.url).href;
  const source=`import {link} from 'node:fs/promises'; import {basename} from 'node:path';
    import {withManifestLock,assertManifestLease} from ${JSON.stringify(base+'manifest-lock.js')};
    import {digest,stageManifest} from ${JSON.stringify(base+'manifest-files.js')};
    import {openManifestReceipts,prepareManifestReceipt} from ${JSON.stringify(base+'manifest-receipts.js')};
    await withManifestLock(${JSON.stringify(path)},{},async lease=>{
      const target=assertManifestLease(lease),bytes=Buffer.from('{}\\n'),staged=await stageManifest(target,bytes);
      const db=await openManifestReceipts(lease);
      prepareManifestReceipt(db,{id:'linked',payloadHash:digest('p'),before:'absent',after:digest(bytes),backup:null,staged:basename(staged)});
      await link(staged,target.path);process.stdout.write('linked');setInterval(()=>{},1000);await new Promise(()=>{});
    });`;
  const child=spawn(process.execPath,['--input-type=module','-e',source],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  t.after(()=>child.kill());await once(child.stdout,'data');const exited=once(child,'exit');child.kill();await exited;
  assert.equal((await readManifestOperation(path,'linked')).persistence,'saved');
  assert.equal((await readManifestSnapshot(path)).state,'present');
});
test('Windows target aliases cannot split a missing manifest mutex', {skip:process.platform!=='win32'}, async t=>{
  const path=await fixture(t);
  await assert.rejects(readManifestSnapshot(path+'.'),{code:'manifest_target_invalid'});
});

test('same lease cannot overlap mutations while a transform is pending', async t=>{
  const path=await fixture(t);
  await withManifestLock(path,{},async lease=>{
    let release,entered;
    const waiting=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
    const first=transactLockedManifest(lease,{...request(path,'absent','first',{}),transform:async()=>{entered();await waiting;return {};}});
    await started;
    await assert.rejects(transactLockedManifest(lease,request(path,'absent','second',{})),{code:'manifest_lock_busy'});
    release();assert.equal((await first).persistence,'saved');
  });
});

test('unawaited registered mutation retains outer lease until filesystem work settles', async t=>{
  const path=await fixture(t);let release,entered,pending;
  const waiting=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const owner=withManifestLock(path,{},async lease=>{
    pending=transactLockedManifest(lease,{...request(path,'absent','owned',{}),transform:async()=>{entered();await waiting;return {};}});
  });
  await started;
  await assert.rejects(withManifestLock(path,{timeoutMs:40},async()=>{}),{code:'manifest_lock_busy'});
  release();await owner;assert.equal((await pending).persistence,'saved');
});

test('independent writer processes cannot both publish the same revision', {timeout:15000}, async t=>{
  const path=await fixture(t), module=new URL('../src/persistence/manifest-transaction.js',import.meta.url).href;
  const execute=id=>new Promise((resolve,reject)=>{
    const source=`import {transactManifest} from ${JSON.stringify(module)};
      try { await transactManifest({path:${JSON.stringify(path)},expectedRevision:'absent',operationId:${JSON.stringify(id)},payload:{id:${JSON.stringify(id)}},transform:()=>({id:${JSON.stringify(id)}}),validate:()=>{}}); process.stdout.write('saved'); }
      catch(error){process.stdout.write(error.code ?? 'unexpected');}`;
    const child=spawn(process.execPath,['--input-type=module','-e',source],{windowsHide:true,stdio:['ignore','pipe','ignore']});
    t.after(()=>child.kill());let result='';child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{result+=chunk;});
    child.on('error',reject);child.on('exit',code=>code===0?resolve(result):reject(new Error('Child failed')));
  });
  assert.deepEqual((await Promise.all([execute('one'),execute('two')])).sort(),['manifest_revision_conflict','saved']);
});

test('POSIX manifest admission permits readable files but refuses foreign-write content', {skip:process.platform==='win32'}, async t=>{
  const path=await fixture(t);await writeFile(path,'{"preserve":true}\n');await chmod(path,0o644);
  const snapshot=await readManifestSnapshot(path);assert.equal(snapshot.rawManifest.preserve,true);
  for (const mode of [0o664,0o646]) {
    await chmod(path,mode);
    await assert.rejects(transactManifest(request(path,snapshot.revision,`mode-${mode}`,{})),{code:'manifest_target_unsafe'});
    assert.equal(await readFile(path,'utf8'),'{"preserve":true}\n');
  }
  await chmod(path,0o644);
  assert.equal((await transactManifest(request(path,snapshot.revision,'readable',{}))).persistence,'saved');
});
