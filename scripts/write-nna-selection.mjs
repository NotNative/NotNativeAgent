// SPDX-License-Identifier: Apache-2.0
/** Installer-owned, nonsecret selection; runtime validation belongs to the client. */
import { randomUUID } from 'node:crypto';
import { realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSelectedNativeRuntime } from '../packages/electron/native-service-client.mjs';

export async function writeNnaSelection(nndRoot, nnaRoot, installationId, dataId) {
  if (![nndRoot, nnaRoot].every((value) => typeof value === 'string' && value.length <= 4096
    && isAbsolute(value) && !/[\u0000-\u001f\u007f]/u.test(value))) throw new Error('Installation roots must be absolute');
  const [root, selected] = await Promise.all([realpath(nndRoot), realpath(nnaRoot)]);
  if (!(await stat(root)).isDirectory() || !(await stat(selected)).isDirectory()) throw new Error('Installation roots must be directories');
  const runtime = readSelectedNativeRuntime(selected);
  if (installationId !== runtime.installation_id || dataId !== runtime.data_id) throw new Error('Selected NNA identity changed');
  const temporary = join(root, `nna-selection.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify({ schema_version: '1.0', nna_install_root: selected,
      installation_id: installationId, data_id: dataId })}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(root, 'nna-service-selection.json'));
  } finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 6) throw new Error('usage: write-nna-selection.mjs ABSOLUTE_NND_ROOT ABSOLUTE_NNA_ROOT INSTALLATION_ID DATA_ID');
  await writeNnaSelection(process.argv[2], process.argv[3], process.argv[4], process.argv[5]);
}
