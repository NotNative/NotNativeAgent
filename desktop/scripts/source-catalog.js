// SPDX-License-Identifier: Apache-2.0
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const MAX_SOURCE_FILES = 2_000;
const SOURCE_ROOTS = ['packages/ui/src', 'packages/web/src', 'scripts'];
const SKIPPED_DIRECTORIES = new Set(['.git', 'coverage', 'dist', 'node_modules', '.pnpm', '__tests__']);

export async function collectProductionSources(root) {
  const pending = SOURCE_ROOTS.map((path) => resolve(root, path));
  const files = [];
  while (pending.length > 0) {
    const directory = pending.pop();
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      throw new Error(`cannot inspect required source directory ${directory}: ${error.code ?? error.message}`, { cause: error });
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)) pending.push(path);
      else if (isProductionSource(entry)) files.push(path);
      if (files.length > MAX_SOURCE_FILES) throw new Error(`source file count exceeds ${MAX_SOURCE_FILES}`);
    }
  }
  return files.sort();
}

function isProductionSource(entry) {
  return entry.isFile()
    && /\.(ts|tsx|mjs|js)$/u.test(entry.name)
    && !/\.test\.[tj]sx?$/u.test(entry.name)
    && !/\.d\.ts$/u.test(entry.name);
}
