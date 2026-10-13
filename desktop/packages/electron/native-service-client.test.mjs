// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchControllerGeneration, launchSelectionFile, readNativeServiceSelection } from './native-service-selection.mjs';
import { writeNnaSelection } from '../../scripts/write-nna-selection.mjs';
import { assertSelectedNndPackage, readSelectedNativeRuntime, attachNativeService,
  probeNativeAttach, validateNativeAttach, redeemNativeAttachment } from './native-service-client.mjs';

async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(),'nnd-shell-native-')));
  const root = join(base,'install'), data = join(base,'data');
  await mkdir(join(root,'installed','src'),{recursive:true}); await mkdir(data);
  t.after(async () => { assert.ok(base.includes('nnd-shell-native-')); await rm(base,{recursive:true,force:true}); });
  const descriptor = { product:'NotNativeAgent',version:'20261002-3',install_root:root,data_root:data,
    node:process.execPath,node_major:Number(process.versions.node.split('.')[0]) };
  await writeFile(join(root,'install.json'),JSON.stringify(descriptor));
  await writeFile(join(root,'installed','package.json'),JSON.stringify({name:'not-native-agent',nna_version:descriptor.version,type:'module'}));
  await writeFile(join(root,'installed','VERSION'),descriptor.version);
  await writeFile(join(root,'installed','src','cli.js'),`import {createHash} from 'node:crypto';import fs from 'node:fs';
    const d=JSON.parse(fs.readFileSync(process.argv.at(-1)+'/install.json'));
    const hash=v=>createHash('sha256').update(v.toLowerCase()).digest('hex');
    const id={protocol:'1.0',installation_id:'nna_'+hash(d.install_root),data_id:'data_'+hash(d.data_root)};
    if(process.env.NODE_OPTIONS||process.env.NNA_HOME) throw new Error('unsafe environment');
    const action=process.argv[4];
    if(action==='attach'&&fs.existsSync(d.data_root+'/slow-attach'))await new Promise(done=>setTimeout(done,6000));
    if(action==='attach'&&fs.existsSync(d.data_root+'/probe-inactive')){
      console.error('nna: nnd_service_not_running');process.exit(2);
    }
    if(action==='start')fs.writeFileSync(d.data_root+'/start-invoked','yes');
    if(action==='attach'&&fs.existsSync(d.data_root+'/fail-attach')){
      console.error('(node) SQLite warning');console.error('nna: nnd_owner_unverified');process.exit(2);
    }
    console.log(JSON.stringify(action==='capabilities'?{...id,native_version:d.version,capabilities:['service_supervision','setup_control_plane','atomic_ui_attach','installer_guard'],commands:['start','status','stop','attach','install-guard']}:
      {...id,generation:'fixture',endpoint:'http://127.0.0.1:4555',ticket:'a'.repeat(43),expires_at:new Date(Date.now()+60000).toISOString()}));`);
  return {root,data,base,descriptor};
}
const windows = {skip:process.platform!=='win32'};
test('immutable shell accepts one external pinned selection path', windows, async t => {
  const f = await fixture(t);
  const file = join(f.base, 'nna-service-selection.json');
  assert.equal(launchSelectionFile(['--nna-install-root', f.root, '--nnd-selection-file', file], 'default'), file);
  assert.throws(() => launchSelectionFile(['--nnd-selection-file', file], 'default'), /conflict/u);
  assert.throws(() => launchSelectionFile(['--nna-install-root', f.root, '--nnd-selection-file', file,
    '--nnd-selection-file', file], 'default'), /conflict/u);
  assert.equal(launchControllerGeneration(['other'], 'default'), 'default');
  assert.equal(launchControllerGeneration(['--nnd-controller-generation', 'fixture-generation']), 'fixture-generation');
  assert.throws(() => launchControllerGeneration(['--nnd-controller-generation', 'fixture-generation',
    '--nnd-controller-generation', 'fixture-generation']), /invalid/u);
  assert.throws(() => launchControllerGeneration(['--nnd-controller-generation', 'bad generation']), /invalid/u);
});

test('desktop package recheck rejects a changed registration before attach', windows, async t => {
  const f = await fixture(t);
  const runtime = readSelectedNativeRuntime(f.root);
  const selection = { mode: 'native', installRoot: f.root, installation_id: runtime.installation_id,
    data_id: runtime.data_id };
  const target = join(f.base, 'active-package'); await mkdir(target);
  const cli = join(f.root, 'installed', 'src', 'cli.js');
  await writeFile(cli, `import fs from 'node:fs';
    if (process.argv.slice(2).join(' ') !== 'nnd package status' || process.env.NNA_HOME !== ${JSON.stringify(f.data)}) process.exit(9);
    console.log(JSON.stringify({ registered: true, valid: true, root: ${JSON.stringify(target)}, version: '20261003-17' }));`);
  assert.equal((await assertSelectedNndPackage(selection, target)).version, '20261003-17');
  assert.equal((await assertSelectedNndPackage(selection, target, '20261003-17')).version, '20261003-17');
  await assert.rejects(assertSelectedNndPackage(selection, target, '20261003-18'), /selection-changed/u);
  await assert.rejects(assertSelectedNndPackage(selection, f.base), /selection-changed/u);
});
test('public attach probe refuses to start an inactive controller', windows, async t => {
  const f = await fixture(t);
  const runtime = readSelectedNativeRuntime(f.root);
  const selection = { installRoot: f.root, installation_id: runtime.installation_id,
    data_id: runtime.data_id };
  await writeFile(join(f.data, 'probe-inactive'), 'yes');
  await assert.rejects(probeNativeAttach(selection), /nnd_service_not_running/u);
  assert.ok(!existsSync(join(f.data, 'start-invoked')));
  await rm(join(f.data, 'probe-inactive'));
  assert.equal((await attachNativeService(selection)).generation, 'fixture');
});
test('selection requires explicit installation and rejects implicit legacy fallback',windows,async t=>{
  const f=await fixture(t); const file=join(f.base,'selection.json');
  assert.throws(()=>readNativeServiceSelection({args:[],selectionFile:file}),/required/);
  const runtime=readSelectedNativeRuntime(f.root);
  await writeNnaSelection(f.base,f.root,runtime.installation_id,runtime.data_id);
  const saved=join(f.base,'nna-service-selection.json');
  assert.deepEqual(readNativeServiceSelection({args:[],selectionFile:saved}),
    {mode:'native',installRoot:f.root,installation_id:runtime.installation_id,data_id:runtime.data_id});
  assert.throws(()=>readNativeServiceSelection({args:[],selectionFile:file}),/required/);
  assert.throws(()=>readNativeServiceSelection({args:['--nna-install-root',f.root],selectionFile:file}),/required/);
  assert.throws(()=>readNativeServiceSelection({args:['--legacy-local-dev'],selectionFile:file}),/conflict/);
  assert.throws(()=>readNativeServiceSelection({args:['--legacy-local-dev','--nna-install-root',f.root],allowLegacy:true}),/conflict/);
  assert.equal(readNativeServiceSelection({args:['--legacy-local-dev'],allowLegacy:true}).mode,'legacy');
});
test('selection rejects stale identity and CLI override before starting a service',windows,async t=>{
  const f=await fixture(t); const runtime=readSelectedNativeRuntime(f.root);
  await writeNnaSelection(f.base,f.root,runtime.installation_id,runtime.data_id);
  const file=join(f.base,'nna-service-selection.json');
  await assert.rejects(writeNnaSelection(f.base,f.root,`nna_${'a'.repeat(64)}`,runtime.data_id),/identity changed/);
  assert.throws(()=>readNativeServiceSelection({args:['--nna-install-root',f.base],selectionFile:file}),/conflict/);
  const other=join(f.base,'other-data'); await mkdir(other);
  await writeFile(join(f.root,'install.json'),JSON.stringify({...f.descriptor,data_root:other}));
  const pinned=readNativeServiceSelection({args:[],selectionFile:file});
  await assert.rejects(attachNativeService(pinned),/identity-changed/);
});
test('startup rechecks native capabilities even with a valid saved identity',windows,async t=>{
  const f=await fixture(t); const runtime=readSelectedNativeRuntime(f.root);
  await writeNnaSelection(f.base,f.root,runtime.installation_id,runtime.data_id);
  const pin=readNativeServiceSelection({args:[],selectionFile:join(f.base,'nna-service-selection.json')});
  const cli=join(f.root,'installed','src','cli.js');
  await writeFile(cli,(await readFile(cli,'utf8')).replace("'installer_guard'", "'removed_guard'"));
  await assert.rejects(attachNativeService(pin),/upgrade-required/);
});
test('selected runtime refuses mismatched payload before executing it',windows,async t=>{
  const f=await fixture(t); assert.equal(readSelectedNativeRuntime(f.root).root,f.root);
  await writeFile(join(f.root,'installed','VERSION'),'20261002-4');
  assert.throws(()=>readSelectedNativeRuntime(f.root),/invalid/);
});
test('private CLI attachment uses selected runtime and generation identity',windows,async t=>{
  const f=await fixture(t); const attached=await attachNativeService(f.root);
  assert.equal(attached.generation,'fixture'); assert.equal(attached.origin,'http://127.0.0.1:4555');
  assert.throws(()=>validateNativeAttach({...attached,installation_id:'wrong'},readSelectedNativeRuntime(f.root)));
});
test('desktop attachment allows slow selected-native response and preserves a native error after warnings',windows,async t=>{
  const f=await fixture(t);
  await writeFile(join(f.data,'slow-attach'),'yes');
  assert.equal((await attachNativeService(f.root)).generation,'fixture');
  await rm(join(f.data,'slow-attach'));
  await writeFile(join(f.data,'fail-attach'),'yes');
  await assert.rejects(attachNativeService(f.root),/nnd_owner_unverified/);
});
test('runtime major mismatch is rejected before invoking capabilities',windows,async t=>{
  const f=await fixture(t);
  await writeFile(join(f.root,'install.json'),JSON.stringify({...f.descriptor,node_major:99}));
  await assert.rejects(attachNativeService(f.root),/runtime-incompatible/);
});
test('redemption stays in supplied session and returns no credentials',async()=>{
  const attached={origin:'http://127.0.0.1:4555',generation:'g',installation_id:'i',data_id:'d',ticket:'private-ticket'};
  let called=false;
  const result=await redeemNativeAttachment(attached,{async fetch(url,options){
    called=true;assert.equal(url,attached.origin+'/auth/native-bootstrap');
    assert.equal(options.headers.Origin,attached.origin);assert.equal(options.credentials,'include');
    assert.equal(options.redirect,'error');assert.deepEqual(JSON.parse(options.body),{ticket:'private-ticket'});
    return Response.json({authenticated:true});
  }});
  assert.equal(called,true);assert.equal(Object.hasOwn(result,'ticket'),false);
  await assert.rejects(redeemNativeAttachment(attached,{fetch:async()=>Response.json({authenticated:false})}));
});
test('redemption bounds untrusted response',async()=>{
  await assert.rejects(redeemNativeAttachment({origin:'http://127.0.0.1:4555',ticket:'ticket'},
    {fetch:async()=>new Response('x'.repeat(16385))}),/authentication/);
});

test('pinned incarnation replaces cleanly, mismatched or stale pin fails closed (ADR 0070)', windows, async t => {
  const f = await fixture(t);
  const file = join(f.base, 'nna-service-selection.json');
  const incarnation = '0f8f9f6e-1a2b-4c3d-9e5f-6a7b8c9d0e1f';
  const withIncarnation = { ...f.descriptor, incarnation_id: incarnation };
  await writeFile(join(f.root, 'install.json'), JSON.stringify(withIncarnation));
  const runtime = readSelectedNativeRuntime(f.root);
  assert.equal(runtime.incarnation_id, incarnation);
  await writeNnaSelection(f.base, f.root, runtime.installation_id, runtime.data_id);
  const pinned = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(pinned.incarnation_id, incarnation);
  const selection = readNativeServiceSelection({ args: [], selectionFile: file });
  assert.equal(selection.incarnation_id, incarnation);
  await probeNativeAttach(selection);
  // Reinstalling at the same roots keeps path identity but replaces the incarnation.
  await writeFile(join(f.root, 'install.json'), JSON.stringify({ ...withIncarnation,
    incarnation_id: '1a8f9f6e-1a2b-4c3d-9e5f-6a7b8c9d0e1f' }));
  await assert.rejects(probeNativeAttach(selection), /identity-changed/u);
  await assert.rejects(assertSelectedNndPackage(selection, f.root), /identity-changed/u);
  // A pre-ADR pin without an identifier proves nothing and keeps prior semantics.
  const legacy = { mode: 'native', installRoot: f.root, installation_id: runtime.installation_id,
    data_id: runtime.data_id };
  assert.match((await probeNativeAttach(legacy)).endpoint, /^http:\/\/(127\.0\.0\.1|\[::1\]):/u);
});
