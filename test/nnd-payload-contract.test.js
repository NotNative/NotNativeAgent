// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePayloadManifest } from '../src/nnd-payload-contract.js';
const row=path=>({path,bytes:1,sha256:'a'.repeat(64)});
const manifest=files=>({schema_version:'1.0',version:'20261002-7',platform:'win32',architecture:'x64',files});
for(const path of ['../escape','a/../b','C:/escape','/absolute','a\\b','file:stream','NUL.txt','dir./file','dir /file','COM\u00b9.log']) {
 test(`portable payload paths reject unsafe name ${JSON.stringify(path)}`,()=>{
  assert.throws(()=>validatePayloadManifest(manifest([row(path)])),{code:'nnd_payload_invalid'});
 });
}
test('manifest rejects unsorted rows, aliases, ancestor collisions and unsupported platform',()=>{
 for(const files of [[row('b'),row('a')],[row('A'),row('a')],[row('a'),row('a/b')]]) {
  assert.throws(()=>validatePayloadManifest(manifest(files)),{code:'nnd_payload_invalid'});
 }
 assert.throws(()=>validatePayloadManifest({...manifest([row('a')]),platform:'linux'}),{code:'nnd_payload_invalid'});
 assert.throws(()=>validatePayloadManifest({...manifest([row('a')]),extra:true}),{code:'nnd_payload_invalid'});
});
test('manifest enforces individual, aggregate and file-count bounds before file reads',()=>{
 assert.throws(()=>validatePayloadManifest(manifest([{...row('a'),bytes:512*1024*1024+1}])),{code:'nnd_payload_invalid'});
 assert.throws(()=>validatePayloadManifest(manifest(Array.from({length:5},(_,i)=>({...row(String(i)),bytes:512*1024*1024})))),{code:'nnd_payload_invalid'});
 assert.throws(()=>validatePayloadManifest(manifest(Array.from({length:20001},(_,i)=>row(String(i))))),{code:'nnd_payload_invalid'});
 assert.doesNotThrow(()=>validatePayloadManifest(manifest([row('directory/file')])));
});
