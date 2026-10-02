// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ContractError } from '../src/ids.js';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const identity={installation_id:'native',data_id:'data',install_root:'C:/native',data_root:'C:/data'};
const paths={config:'C:/data/config'};
const packageInfo={root:'C:/package',manifestPath:'C:/package/integration.json',version:'20261002-1',protocol:'1.0',entrypoint:'entry.mjs'};
async function fixture(options={}) {
 const trace=[],lost=deferred(),childReady=deferred(),exited=deferred(),fatal=deferred();let controller,bootstrap,nativeOptions,closeCalls=0;
 const lease={held:true,lost:lost.promise,close:async()=>{trace.push('lease:close');}};
 const native={endpoint:'http://127.0.0.1:1000',token:'private-engine-token',runtime:{snapshot:()=>({service_state:'setup_required'})},close:async()=>{trace.push('native:close');}};
 const child={ready:childReady.promise,exited:exited.promise,fatal:fatal.promise,close:async()=>{trace.push('child:close');},command:async type=>{trace.push(type);return {ticket:'private-ticket'};}};
 const assertLease=(value,dataId)=>{if(value!==lease||!lease.held||dataId!==identity.data_id)throw new ContractError('nnd_lock_lost','Genuine lease required');};
 const capability=Object.freeze({}),registry={held:true};
 const dependencies={randomUUID,join,resolve: path=>path,ContractError,assertHeldNndServiceLease:assertLease,
  assertManifestLease:value=>{if(value!==registry||!registry.held)throw new ContractError('manifest_lock_invalid','Registry ownership lost');
   return {path:join(identity.data_root,'config','nnd-package.json')};},
  runManifestLeaseWork:(_lease,operation)=>operation(),
  userDataPaths:()=>({root:identity.data_root,config:paths.config}),
  consumeNndTrialCapability:(value,_identity,held,guard)=>{
   if(value!==capability||held!==lease||guard!==registry)throw new ContractError('nnd_activation_candidate_invalid','Trial capability invalid');
   return packageInfo;
  },
  acquireNndServiceLock:async()=>{trace.push('lease:acquire');return lease;},
  open:async path=>{const bytes=Buffer.from(JSON.stringify(path.endsWith('nnd-package.json')?{root:packageInfo.root,version:packageInfo.version,protocol:'1.0'}:{service_activation:{entrypoint:'entry.mjs'}}));return {
   stat:async()=>({isFile:()=>true,size:bytes.length}),read:async buffer=>({bytesRead:bytes.copy(buffer)}),close:async()=>{}};},
  mkdir:async()=>{},realpath:async path=>path,validateNndPackage:async()=>{trace.push('package:admit');return packageInfo;},
  assertNoNndInstallMarker:async()=>{trace.push('guard:check');},admitFreshNndServiceData:async()=>{trace.push('data:admit');},
  readNndServiceDiscovery:async()=>{trace.push('discovery:read');return null;},startNndNativeService:async (_paths,_identity,options)=>{nativeOptions=options;trace.push('native:start');return native;},
  startNndController:async controllerOptions=>{trace.push('controller:start');await options.controllerGate?.promise;
   controller=controllerOptions;return {endpoint:'http://127.0.0.1:2000',close:async()=>{trace.push('controller:close');
    if(options.controllerCloseFailsOnce && closeCalls++===0)throw new Error('controller close failed');}};},
  createNndDiscoveryGeneration:async()=>{trace.push('discovery:create');return {instance_id:randomUUID()};},
  createNndTrialDiscoveryGeneration:async (_identity,_lease,{endpoint,instanceId})=>{
   trace.push('trial-discovery:create');return {instance_id:options.generationOverride??instanceId,endpoint,control_token:'private'};},
  selectNndTrialRegistrationUnderOwnership:async (_identity,_state,_lease,_registry,selection)=>{
   trace.push('registration:select');return {state:'registration_selected_unresolved',operation_id:selection.operationId};},
  discardNndTrialDiscoveryGeneration:async (_identity,_lease,instanceId)=>{
   assert.equal(instanceId,bootstrap.generation);trace.push('trial-discovery:discard');return {discarded:true};},
  publishNndDiscoveryGeneration:async()=>{trace.push('discovery:publish');},removeNndDiscoveryPointer:async()=>{trace.push('discovery:remove');},
  launchNndServiceChild:(_identity,_entrypoint,value)=>{trace.push('child:start');bootstrap=value;return child;},
  createServer:()=>{const server=new EventEmitter();server.listen=(_port,_host,ready)=>queueMicrotask(ready);server.address=()=>({port:3000});server.close=callback=>callback();return server;}};
 // Security: only this test harness exposes the private constructor; production exports remain unchanged.
 const source=await readFile(new URL('../src/nnd-service-supervisor.js',import.meta.url),'utf8');
 const executable=source.replace(/^import\s[\s\S]*?;\r?\n/gm,'').replaceAll('export async function','async function');
 const api=Function(...Object.keys(dependencies),executable+'\nreturn {startNndSupervisor,startUnpublishedTrial,startNndOwnedTrial};')(...Object.values(dependencies));
 return {api,trace,lease,registry,capability,native,child,childReady,lost,exited,fatal,source,get controller(){return controller;},get bootstrap(){return bootstrap;},get nativeOptions(){return nativeOptions;}};
}
async function waitFor(predicate) {for(let n=0;n<100;n++){if(predicate())return;await new Promise(resolve=>setImmediate(resolve));}throw new Error('Expected mocked lifecycle phase');}
test('public supervision still admits registered package and withholds controller grants before publication',async()=>{
 const f=await fixture(),started=f.api.startNndSupervisor(identity,paths,{skipAdmission:true,packageRoot:'C:/untrusted'});
 await waitFor(()=>f.trace.includes('child:start'));
 assert.equal(f.controller.getRecord(),null);await assert.rejects(f.controller.ticket(),{code:'nnd_service_not_running'});
 assert.ok(f.trace.indexOf('package:admit')<f.trace.indexOf('native:start'));assert.ok(f.trace.includes('data:admit'));
 f.childReady.resolve();const owner=await started;
 assert.ok(f.controller.getRecord());assert.deepEqual(await f.controller.ticket(),{ticket:'private-ticket'});
 await owner.stop();await owner.stopped;
 assert.ok(f.trace.indexOf('child:close')<f.trace.indexOf('lease:close'));assert.ok(f.trace.includes('discovery:remove'));
});
test('unpublished owned trial cannot publish discovery or grant tickets and retains caller lease after drain',async()=>{
 const f=await fixture();assert.equal(/export\s+(?:async\s+)?function\s+startUnpublishedTrial/u.test(f.source),false);
 f.childReady.resolve();const owner=await f.api.startUnpublishedTrial(identity,paths,f.lease,packageInfo);
 assert.equal(f.nativeOptions.unpublishedTrial,true);
 assert.equal(f.controller,undefined);assert.equal(f.trace.some(event=>event.startsWith('discovery:')),false);
 assert.deepEqual(Object.keys(owner).sort(),['status','stop','stopped','verify']);assert.equal(JSON.stringify(owner.status()).includes('private-engine-token'),false);
 const gate=deferred();f.native.close=async()=>{f.trace.push('native:draining');await gate.promise;f.trace.push('native:drained');};
 let stopped=false;const closing=owner.stop().then(()=>{stopped=true;});await waitFor(()=>f.trace.includes('native:draining'));
 assert.equal(stopped,false);gate.resolve();await closing;assert.equal(f.trace.includes('lease:close'),false);
});
test('owned trial creates only a dark discovery record for its live child generation',async()=>{
 const f=await fixture();f.childReady.resolve();
 const owner=await f.api.startNndOwnedTrial(identity,{...paths,root:identity.data_root},f.lease,f.registry,f.capability);
 const record=await owner.prepareDiscovery();
 assert.equal(record.instance_id,f.bootstrap.generation);
 assert.equal(record.endpoint,'http://127.0.0.1:2000');
 assert.equal(f.controller.getRecord(),null);
 await assert.rejects(f.controller.ticket(),{code:'nnd_service_not_running'});
 assert.equal(f.trace.includes('discovery:publish'),false);
 await assert.rejects(owner.prepareDiscovery(),{code:'nnd_discovery_invalid'});
 await owner.stop();
 assert.ok(f.trace.includes('controller:close'));
 assert.ok(f.trace.includes('trial-discovery:discard'));
});
test('trial discovery preparation refuses an expired registry lock without starting a controller',async()=>{
 const f=await fixture();f.childReady.resolve();
 const owner=await f.api.startNndOwnedTrial(identity,{...paths,root:identity.data_root},f.lease,f.registry,f.capability);
 f.registry.held=false;
 await assert.rejects(owner.prepareDiscovery(),{code:'manifest_lock_invalid'});
 assert.equal(f.controller,undefined);
 await owner.stop();
});
test('concurrent trial preparation cannot start two controllers for one child generation',async()=>{
 const gate=deferred(),f=await fixture({controllerGate:gate});f.childReady.resolve();
 const owner=await f.api.startNndOwnedTrial(identity,{...paths,root:identity.data_root},f.lease,f.registry,f.capability);
 const first=owner.prepareDiscovery();await waitFor(()=>f.trace.includes('controller:start'));
 await assert.rejects(owner.prepareDiscovery(),{code:'nnd_discovery_invalid'});
 gate.resolve();await first;
 assert.equal(f.trace.filter(event=>event==='controller:start').length,1);
 assert.equal(f.trace.filter(event=>event==='trial-discovery:create').length,1);
 await owner.stop();
});
test('stop drains a controller still starting and prevents late dark record creation',async()=>{
 const gate=deferred(),f=await fixture({controllerGate:gate});f.childReady.resolve();
 const owner=await f.api.startNndOwnedTrial(identity,{...paths,root:identity.data_root},f.lease,f.registry,f.capability);
 const preparing=owner.prepareDiscovery();await waitFor(()=>f.trace.includes('controller:start'));
 let stopped=false;const stopping=owner.stop().then(()=>{stopped=true;});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(stopped,false);
 gate.resolve();await assert.rejects(preparing,{code:'nnd_discovery_invalid'});await stopping;
 assert.equal(f.trace.filter(event=>event==='controller:close').length,1);
 assert.equal(f.trace.includes('trial-discovery:create'),false);
 assert.equal(f.trace.includes('trial-discovery:discard'),false);
});
test('mismatched fixed generation closes the dark controller and never publishes',async()=>{
 const f=await fixture({generationOverride:randomUUID()});f.childReady.resolve();
 const owner=await f.api.startNndOwnedTrial(identity,{...paths,root:identity.data_root},f.lease,f.registry,f.capability);
 await assert.rejects(owner.prepareDiscovery(),{code:'nnd_discovery_invalid'});
 assert.ok(f.trace.includes('controller:close'));
 assert.equal(f.trace.includes('discovery:publish'),false);
 await owner.stop();
 assert.ok(f.trace.includes('trial-discovery:discard'));
});
test('registration selection is single-use and requires private discovery preparation',async()=>{
 const f=await fixture();f.childReady.resolve();
 const owner=await f.api.startNndOwnedTrial(identity,{...paths,root:identity.data_root},f.lease,f.registry,f.capability);
 await assert.rejects(owner.selectRegistration({operationId:randomUUID()}),{code:'nnd_activation_registration_invalid'});
 await owner.prepareDiscovery();
 const selected=await owner.selectRegistration({operationId:randomUUID()});
 assert.equal(selected.state,'registration_selected_unresolved');
 await assert.rejects(owner.selectRegistration({operationId:randomUUID()}),{code:'nnd_activation_registration_invalid'});
 assert.equal(f.trace.filter(event=>event==='registration:select').length,1);
 assert.equal(f.controller.getRecord(),null);assert.equal(f.trace.includes('discovery:publish'),false);
 await owner.stop();
});
test('failed trial controller close is retried on stop and dark credential is discarded',async()=>{
 const f=await fixture({generationOverride:randomUUID(),controllerCloseFailsOnce:true});f.childReady.resolve();
 const owner=await f.api.startNndOwnedTrial(identity,{...paths,root:identity.data_root},f.lease,f.registry,f.capability);
 await assert.rejects(owner.prepareDiscovery(),AggregateError);
 await owner.stop();
 assert.equal(f.trace.filter(event=>event==='controller:close').length,2);
 assert.ok(f.trace.includes('trial-discovery:discard'));
});
test('unpublished trial proves exact native identity and loopback GUI before exposing a health result',async()=>{
 const f=await fixture();f.childReady.resolve();const owner=await f.api.startNndOwnedTrial(identity,{...paths,root:identity.data_root},f.lease,f.registry,f.capability);
 const observed=[];
 const proof=await owner.verify({fetchImpl:async (url,options)=>{
  observed.push({url,redirect:options.redirect});
  if(url.endsWith('/v1/health'))assert.equal(options.headers.authorization,'Bearer private-engine-token');
  const value=url.endsWith('/v1/health')
   ? {service_state:'setup_required',instance_id:identity.installation_id}
   : {ok:true,runtime:'service'};
  return {status:200,redirected:false,url,body:new Response(JSON.stringify(value)).body};
 }});
 assert.equal(proof.installation_id,identity.installation_id);assert.equal(proof.data_id,identity.data_id);
 assert.equal(proof.version,packageInfo.version);assert.equal(proof.native_state,'setup_required');
 assert.equal(proof.gui_http_status,200);assert.equal(observed[1].url,`${owner.status().endpoint}/health`);
 assert.equal(observed[0].url,`${f.native.endpoint}/v1/health`);
 assert.equal(observed[0].redirect,'manual');
 await owner.stop();
});
test('unpublished trial rejects dead child and a redirected or timed-out GUI probe',async()=>{
 const f=await fixture();f.childReady.resolve();const owner=await f.api.startUnpublishedTrial(identity,paths,f.lease,packageInfo);
 await assert.rejects(owner.verify({fetchImpl:async url=>({status:302,redirected:false,url})}),{code:'nnd_health_unavailable'});
 await assert.rejects(owner.verify({fetchImpl:async url=>({status:401,redirected:false,url})}),{code:'nnd_health_unavailable'});
 await assert.rejects(owner.verify({fetchImpl:async url=>({status:200,redirected:false,url,
  body:new Response('x'.repeat(5000)).body})}),{code:'nnd_health_unavailable'});
 await assert.rejects(owner.verify({fetchImpl:async()=>{throw new Error('connection refused');}}),{code:'nnd_health_unavailable'});
 f.child.failed=true;
 await assert.rejects(owner.verify({fetchImpl:async url=>({status:200,redirected:false,url,body:new Response(JSON.stringify({ok:true,runtime:'service'})).body})}),{code:'nnd_health_unavailable'});
 await owner.stop();
});
test('trial constructor refuses forged lease before starting resources',async()=>{
 const f=await fixture();await assert.rejects(f.api.startUnpublishedTrial(identity,paths,{},packageInfo),{code:'nnd_lock_lost'});
 assert.deepEqual(f.trace,[]);
});
test('owned trial requires matching native data paths before consuming its private capability',async()=>{
 const f=await fixture();
 await assert.rejects(f.api.startNndOwnedTrial(identity,{root:'C:/foreign',config:paths.config},f.lease,f.registry,f.capability),
  {code:'nnd_activation_candidate_invalid'});
 assert.deepEqual(f.trace,[]);
 f.childReady.resolve();const owner=await f.api.startNndOwnedTrial(identity,{...paths,root:identity.data_root},f.lease,f.registry,f.capability);
 assert.equal(f.trace.includes('native:start'),true);assert.equal(f.trace.some(event=>event.startsWith('discovery:')),false);
 await owner.stop();
});
test('failed trial drains started resources without releasing caller lease',async()=>{
 const f=await fixture(),starting=f.api.startUnpublishedTrial(identity,paths,f.lease,packageInfo);
 await waitFor(()=>f.trace.includes('child:start'));f.childReady.reject(new Error('Child startup rejected'));
 await assert.rejects(starting,/Child startup rejected/u);
 assert.ok(f.trace.includes('native:close'));assert.ok(f.trace.includes('child:close'));assert.equal(f.trace.includes('lease:close'),false);
});
test('uncertain resource shutdown never releases the public singleton',async()=>{
 const f=await fixture();f.childReady.resolve();const owner=await f.api.startNndSupervisor(identity,paths);
 f.child.close=async()=>{throw new Error('Writer still alive');};
 await assert.rejects(owner.stop(),/shutdown incomplete/u);assert.equal(f.trace.includes('lease:close'),false);
 assert.equal(f.trace.includes('discovery:remove'),false);assert.ok((await owner.stopped).error);
});

test('public identity mismatch releases only its newly acquired lease before admission',async()=>{
 const f=await fixture();await assert.rejects(f.api.startNndSupervisor({...identity,data_id:'foreign'},paths),{code:'nnd_lock_lost'});
 assert.deepEqual(f.trace,['lease:acquire','lease:close']);
});

test('public startup losing ownership before child readiness drains resources without publishing',async()=>{
 const f=await fixture(),starting=f.api.startNndSupervisor(identity,paths);
 await waitFor(()=>f.trace.includes('child:start'));f.lease.held=false;f.childReady.resolve();
 await assert.rejects(starting,{code:'nnd_lock_lost'});
 assert.equal(f.trace.includes('discovery:publish'),false);assert.equal(f.controller.getRecord(),null);
 for(const resource of ['native:close','child:close','controller:close','lease:close'])assert.ok(f.trace.includes(resource));
});

test('public child startup failure closes unpublished controller and releases owned singleton',async()=>{
 const f=await fixture(),starting=f.api.startNndSupervisor(identity,paths);
 await waitFor(()=>f.trace.includes('child:start'));f.childReady.reject(new Error('Startup failed'));
 await assert.rejects(starting,/Startup failed/u);
 assert.equal(f.trace.includes('discovery:publish'),false);assert.equal(f.trace.includes('discovery:remove'),false);
 assert.ok(f.trace.indexOf('controller:close')<f.trace.indexOf('lease:close'));
});

test('trial child failure drains once and reports uncertain shutdown while retaining borrowed ownership',async()=>{
 const f=await fixture();f.childReady.resolve();const owner=await f.api.startUnpublishedTrial(identity,paths,f.lease,packageInfo);
 f.native.close=async()=>{f.trace.push('native:close');throw new Error('Pending native writer');};
 f.fatal.resolve(new Error('Child protocol failure'));const result=await owner.stopped;
 assert.ok(result.error instanceof AggregateError);await assert.rejects(owner.stop(),/shutdown incomplete/u);
 assert.equal(f.trace.filter(event=>event==='native:close').length,1);
 assert.equal(f.trace.filter(event=>event==='child:close').length,1);assert.equal(f.trace.includes('lease:close'),false);
 assert.equal(f.trace.some(event=>event.startsWith('discovery:')),false);
});

test('concurrent stop requests share resource drain and release ownership exactly once',async()=>{
 const f=await fixture();f.childReady.resolve();const owner=await f.api.startNndSupervisor(identity,paths);
 const gate=deferred();f.child.close=async()=>{f.trace.push('child:close');await gate.promise;};
 const first=owner.stop(),second=owner.stop();assert.equal(first,second);assert.equal(f.trace.includes('lease:close'),false);
 gate.resolve();await Promise.all([first,second,owner.stopped]);
 for(const resource of ['native:close','child:close','controller:close','lease:close'])assert.equal(f.trace.filter(event=>event===resource).length,1);
});
