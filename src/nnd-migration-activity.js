// SPDX-License-Identifier: Apache-2.0
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { validActivityRecord } from './nnd-activity-snapshot.js';
import { boundedMigrationRead, digest, migrationError, parseMigrationJson } from './nnd-migration-files.js';

// Invariant: display sidecars are validated and preserved as evidence, never rewritten or granted authority.
export async function validateMigrationActivity(paths, parents, evidence, signal) {
  const directory = join(paths.sessions, 'nnd-contexts.json.activity');
  let details;
  try { details = await lstat(directory); }
  catch (error) { if (error.code === 'ENOENT') return 0; throw migrationError(error); }
  if (!details.isDirectory() || details.isSymbolicLink()) throw migrationError();
  let total = 0;
  for (const parent of parents) {
    signal.throwIfAborted();
    const name = `${Buffer.from(parent.sessionId, 'utf8').toString('hex')}.json`;
    const path = `sessions/nnd-contexts.json.activity/${name}`;
    const bytes = await boundedMigrationRead(paths.root, join(paths.root, path), 2097152, true);
    if (!bytes) continue;
    total += bytes.length;
    if (total > 33554432) throw migrationError();
    const snapshot = parseMigrationJson(bytes);
    if (!snapshot || snapshot.version !== 1 || snapshot.sessionId !== parent.sessionId
      || !Number.isSafeInteger(snapshot.createdAt) || !Array.isArray(snapshot.records)
      || snapshot.records.length > 500
      || snapshot.records.some((record) => !validActivityRecord(record, parent.sessionId))) throw migrationError();
    evidence.push({ path, hash: digest(bytes), limit: 2097152 });
  }
  return total;
}
