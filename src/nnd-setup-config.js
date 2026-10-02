// SPDX-License-Identifier: Apache-2.0
import { open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { resolveManifest } from './config.js';
import { ContractError } from './ids.js';

const MAX_MANIFEST_BYTES = 1_048_576;
export const NND_CONFIGURATION_OPTIONS = Object.freeze({
  missionPrincipal: 'authenticated-nnd-operator', principal: 'authenticated-nnd-operator',
  hostOrigin: 'nnd-integration', hostIdentity: 'nnd-integration',
});

export async function readNndSetupConfiguration(paths, signal) {
  signal?.throwIfAborted();
  const handle = await open(join(paths.config, 'manifest.json'), 'r');
  let bytes;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) throw invalid();
    const buffer = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
    let count = 0;
    while (count < buffer.length) {
      signal?.throwIfAborted();
      const read = await handle.read(buffer, count, buffer.length - count, null);
      if (read.bytesRead === 0) break;
      count += read.bytesRead;
    }
    if (count > MAX_MANIFEST_BYTES) throw invalid();
    bytes = buffer.subarray(0, count);
  } finally { await handle.close(); }
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const root = manifest?.workspace_root;
  // Security: a background process working directory never selects workspace authority.
  if (typeof root !== 'string' || root.length > 4096 || !isAbsolute(root)
    || /[\u0000-\u001f\u007f]/u.test(root)) throw invalid();
  signal?.throwIfAborted();
  return resolveManifest(manifest, NND_CONFIGURATION_OPTIONS);
}

function invalid() {
  return new ContractError('nnd_setup_configuration_invalid', 'NND requires a bounded valid manifest with an explicit absolute workspace.');
}
