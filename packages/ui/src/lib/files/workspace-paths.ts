// SPDX-License-Identifier: Apache-2.0
/**
 * Workspace path bridge (doc 06 §2.2): fs/list entries and dialog products
 * speak the CALLER's path space (absolute, platform separators), while git
 * status/diff speak repo-relative POSIX. Review surfaces join the two via
 * stripWorkspacePrefix (case-insensitive, drive-letter tolerant); relative
 * derivation returns null outside the root (status lookups fall back to no
 * badge rather than guessing).
 */
export function normalizeSeparators(path: string): string {
  const slashes = path.replaceAll('\\', '/');
  return slashes.length > 1 ? slashes.replace(/\/+$/u, '') : slashes;
}

export function workspaceRelativePath(root: string, path: string): string | null {
  const rootNorm = normalizeSeparators(root);
  const pathNorm = normalizeSeparators(path);
  if (rootNorm.length === 0) return pathNorm;
  if (pathNorm.toLowerCase() === rootNorm.toLowerCase()) return '';
  const prefix = `${rootNorm.toLowerCase()}/`;
  if (!pathNorm.toLowerCase().startsWith(prefix)) return null;
  return pathNorm.slice(rootNorm.length + 1);
}

export function parentDirOfPath(path: string): string {
  const normalized = normalizeSeparators(path);
  const slash = normalized.lastIndexOf('/');
  return slash <= 0 ? '.' : normalized.slice(0, slash);
}
