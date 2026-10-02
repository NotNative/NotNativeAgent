// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNndInstallRuntimePaths } from '../src/nnd-install-storage-paths.js';
const check=(root,path)=>assertNndInstallRuntimePaths(root,{files:[{path}]});
test('Windows runtime path limits count UTF-16 units and retain terminator room',()=>{
 assert.doesNotThrow(()=>check(String.raw`C:\s`,'a'.repeat(254)));
 assert.throws(()=>check(String.raw`C:\s`,'a'.repeat(255)),{code:'nnd_install_path_too_long'});
 assert.doesNotThrow(()=>check(String.raw`C:\s`,'a'.repeat(125)+'\uD83D\uDE00'.repeat(64)));
 assert.throws(()=>check(String.raw`C:\s`,'a'.repeat(127)+'\uD83D\uDE00'.repeat(64)),{code:'nnd_install_path_too_long'});
});
test('legacy directory budget is enforced independently of the final file budget',()=>{
 assert.doesNotThrow(()=>check(String.raw`C:\s`,'d'.repeat(242)+'/x'));
 assert.throws(()=>check(String.raw`C:\s`,'d'.repeat(243)+'/x'),{code:'nnd_install_path_too_long'});
});
