// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

export function readLaunchPreferences(file) {
  let bytes;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('launch-preferences-invalid');
    bytes = readFileSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return { revision: 'absent', target: 'desktop' };
    throw error;
  }
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('launch-preferences-invalid'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'target,version' || value.version !== 1
    || !['desktop', 'browser'].includes(value.target)) throw new Error('launch-preferences-invalid');
  return { revision: createHash('sha256').update(bytes).digest('hex'), target: value.target };
}

/** Invariant: only the local singleton shell writes this device preference; shortcuts only read it. */
export function saveLaunchPreferences(file, payload) {
  if (!payload || Object.keys(payload).sort().join(',') !== 'revision,target'
    || typeof payload.revision !== 'string' || !['desktop', 'browser'].includes(payload.target)) throw new Error('launch-preferences-invalid');
  if (readLaunchPreferences(file).revision !== payload.revision) throw new Error('launch-preferences-conflict');
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify({ version: 1, target: payload.target }) + '\n', { flag: 'wx' });
    renameSync(temp, file);
  } finally { rmSync(temp, { force: true }); }
  return readLaunchPreferences(file);
}
