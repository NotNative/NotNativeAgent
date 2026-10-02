// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { assertManifestLease } from '../persistence/manifest-lock.js';
import { regularOrMissing, writePrivateFile } from '../persistence/manifest-files.js';

export async function backupManifestSnapshot(lease, snapshot) {
  const target = assertManifestLease(lease);
  if (snapshot.state !== 'present' || snapshot.path !== target.path) return;
  const backup = `${target.path}.bak`;
  await regularOrMissing(backup);
  const staged = join(target.storage, `stage-${randomUUID()}.json`);
  try {
    // Compatibility: retain exact operator-visible backup bytes without following a backup link.
    await writePrivateFile(staged, snapshot.rawBytes);
    await rename(staged, backup);
  } finally {
    await unlink(staged).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
