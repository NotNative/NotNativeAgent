// SPDX-License-Identifier: Apache-2.0
import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';

const SKIPPED_DIRECTORIES = new Set(['.git', 'coverage', 'dist', 'node_modules']);

export async function collectSourceFiles(directory, maxFiles) {
  const pending = [directory];
  const result = [];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch (error) { throw new Error(`cannot inspect ${current}: ${error.code ?? error.message}`, { cause: error }); }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) pending.push(path);
        continue;
      }
      if (entry.isSymbolicLink()) throw new Error(`source entry is a symlink: ${path}`);
      if (!entry.isFile() || extname(entry.name) !== '.js') continue;
      result.push(path);
      if (result.length > maxFiles) throw new Error(`source file count exceeds ${maxFiles}`);
    }
  }
  return result;
}
