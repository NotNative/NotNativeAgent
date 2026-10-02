// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { ContractError } from './ids.js';

export const migrationError = (cause) => new ContractError('nnd_migration_invalid', 'NND migration evidence is invalid; existing evidence was preserved.', { cause });
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export async function boundedMigrationRead(root, path, limit, optional = false) {
  let metadata;
  try { metadata = await lstat(path); } catch (error) { if (optional && error.code === 'ENOENT') return null; throw migrationError(error); }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > limit) throw migrationError();
  const part = relative(await realpath(root), await realpath(path));
  if (isAbsolute(part) || part === '..' || part.startsWith('..\\') || part.startsWith('../')) throw migrationError();
  const file = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(limit + 1); let count = 0;
    while (count < bytes.length) {
      const read = await file.read(bytes, count, bytes.length - count, null);
      if (!read.bytesRead) break; count += read.bytesRead;
    }
    if (count > limit) throw migrationError();
    return bytes.subarray(0, count);
  } finally { await file.close(); }
}
export function parseMigrationJson(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch (cause) { throw migrationError(cause); }
}
export async function writeMigrationNew(path, bytes) {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}
export async function replaceMigrationBytes(path, bytes, nonce) {
  const temporary = join(dirname(path), `.nnd-migration-${nonce}.tmp`);
  await writeMigrationNew(temporary, bytes);
  await rename(temporary, path);
}
export async function removeMigrationOwned(path, expected, root) {
  const bytes = await boundedMigrationRead(root, path, 65536);
  if (digest(bytes) !== digest(expected)) throw migrationError();
  await unlink(path);
}
