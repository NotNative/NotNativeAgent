// SPDX-License-Identifier: Apache-2.0
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ROOT_FILES = new Set(['package.json', 'README.md', 'VERSION', 'pnpm-workspace.yaml',
  'pnpm-lock.yaml', 'tsconfig.base.json', 'install.ps1', 'install.sh']);
const PREFIXES = ['packages/ui/src/', 'packages/web/src/', 'packages/web/public/',
  'packages/electron/', 'scripts/', 'docs/architecture/', 'docs/build/', 'docs/planning/'];
const PACKAGE_FILES = new Set(['packages/web/package.json', 'packages/ui/package.json',
  'packages/web/index.html', 'packages/web/vite.config.ts', 'packages/web/tsconfig.ui.json',
  'packages/web/tsconfig.server.json', 'packages/ui/tsconfig.json', 'packages/ui/vitest.config.ts']);
const GENERATED = new Set(['node_modules', 'dist', 'dist-server', 'dist-electron', '.git',
  '.pnpm', '.pnpm-store', 'coverage']);

function generated(name) {
  return name.split('/').some((part) => GENERATED.has(part))
    || name === 'packages/electron/build-stamp.json'
    || name === 'packages/electron/install-mode.txt'
    || name === 'packages/electron/resources/web-dist'
    || name.startsWith('packages/electron/resources/web-dist/');
}

export function releaseEligible(name) {
  if (generated(name)) return false;
  return ROOT_FILES.has(name) || PACKAGE_FILES.has(name)
    || PREFIXES.some((prefix) => name.startsWith(prefix));
}

function neededDirectory(name) {
  if (generated(name)) return false;
  const prefix = `${name}/`;
  return PREFIXES.some((item) => item.startsWith(prefix) || prefix.startsWith(item))
    || [...PACKAGE_FILES].some((item) => item.startsWith(prefix));
}

export async function releaseFiles(root) {
  const pending = [{ path: root, depth: 0 }], files = [];
  let visited = 0;
  while (pending.length) {
    const current = pending.pop();
    if (++visited > 5000 || current.depth > 32) throw new Error('Release directory bound exceeded');
    const entries = await readdir(current.path, { withFileTypes: true });
    if (entries.length > 10000) throw new Error('Release directory entry bound exceeded');
    for (const entry of entries) {
      const path = join(current.path, entry.name);
      const name = relative(root, path).replaceAll('\\', '/');
      // Security: release traversal never follows junctions or symbolic links into unrelated files.
      if (entry.isSymbolicLink() && (releaseEligible(name) || neededDirectory(name))) {
        throw new Error(`Release source link is unsupported: ${name}`);
      }
      if (entry.isDirectory() && neededDirectory(name)) pending.push({ path, depth: current.depth + 1 });
      else if (entry.isFile() && releaseEligible(name)) files.push(path);
      if (files.length > 20000) throw new Error('Release file bound exceeded');
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}
