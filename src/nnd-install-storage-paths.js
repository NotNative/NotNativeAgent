// SPDX-License-Identifier: Apache-2.0
import { win32 } from 'node:path';
import { ContractError } from './ids.js';
// Compatibility: external Electron/native libraries do not uniformly support extended Windows paths.
// Invariant: these UTF-16 limits include room for the terminator and legacy directory creation suffix.
export function assertNndInstallRuntimePaths(slot, manifest) {
 const paths=['NND_PAYLOAD.json',...manifest.files.map(file=>file.path)];
 for(const relative of paths) {
  const target=win32.join(slot,relative);
  if(target.length>259||target.split('\\').some(part=>part.length>255)) throw pathTooLong();
  let directory=win32.dirname(target);
  for(let depth=0;depth<256;depth++) {
   if(directory.length>247)throw pathTooLong();
   const parent=win32.dirname(directory);if(parent===directory)break;directory=parent;
  }
 }
}
function pathTooLong() {
 return new ContractError('nnd_install_path_too_long',
  'NND runtime paths exceed supported Windows limits. Select a shorter canonical NNA data root before staging this payload.');
}
