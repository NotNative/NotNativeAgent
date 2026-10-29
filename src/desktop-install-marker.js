// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { lstat, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ensurePrivateDesktopRuntimeDirectory } from './desktop-service-private-storage.js';
import { ContractError } from './ids.js';

async function markerPath(identity) {
  const directory = await ensurePrivateDesktopRuntimeDirectory(identity.data_root);
  return join(directory.path, 'installation-guard.json');
}
export async function assertNoDesktopInstallMarker(identity) {
  // Compatibility: POSIX desktop serves do not use the Windows ACL-backed installer,
  // but must still refuse any pending marker in the shared runtime namespace.
  const path = process.platform === 'win32' ? await markerPath(identity)
    : join(identity.data_root, 'runtime', 'desktop', 'installation-guard.json');
  try { await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new ContractError('desktop_install_guard_orphaned', 'desktop installation has an unfinished guard. Verify installer writers stopped before native recovery.');
}
export async function createDesktopInstallMarker(identity) {
  const path = await markerPath(identity);
  const record = { protocol: '1.0', installation_id: identity.installation_id, data_id: identity.data_id, nonce: randomUUID() };
  let file;
  try { file = await open(path, 'wx', 0o600); }
  catch (cause) { throw new ContractError('desktop_install_guard_orphaned', 'desktop installation guard already exists or cannot be verified', { cause }); }
  try { await file.writeFile(JSON.stringify(record)); await file.sync(); }
  finally { await file.close(); }
  return { path, record };
}
export async function clearDesktopInstallMarker(marker) {
  const file = await open(marker.path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 1024) throw new Error('marker bound');
    const buffer = Buffer.alloc(1025); const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 1024 || buffer.subarray(0, bytesRead).toString('utf8') !== JSON.stringify(marker.record)) throw new Error('marker changed');
  } catch (cause) { throw new ContractError('desktop_install_guard_orphaned', 'desktop installation guard changed; ownership was preserved', { cause }); }
  finally { await file.close(); }
  await unlink(marker.path);
}
