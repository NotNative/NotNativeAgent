// SPDX-License-Identifier: Apache-2.0
/** Resolve a Notes owner from the authenticated project roster, not a guessed path. */
export function resolveContextProjectId(directory: string, projects: Record<string, unknown>[]): string | null {
  const target = normalizedProjectPath(directory);
  const matches = projects.flatMap((project) => {
    const id = project['id'];
    const worktree = project['worktree'];
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(id) || typeof worktree !== 'string') return [];
    const base = normalizedProjectPath(worktree);
    return base && (target === base || target.startsWith(`${base}/`)) ? [{ id, length: base.length }] : [];
  });
  matches.sort((a, b) => b.length - a.length);
  // If the roster assigns the same directory to different IDs, there is no
  // safe owner for a write. Wait for the project roster to be corrected.
  if (matches.length > 1 && matches[0]!.length === matches[1]!.length && matches[0]!.id !== matches[1]!.id) return null;
  return matches[0]?.id ?? null;
}

function normalizedProjectPath(value: string): string {
  let path = value.trim().replaceAll('\\', '/').replace(/\/+$/u, '');
  // Lexical traversal aliases can make a directory appear to belong to the
  // wrong project. Leave such paths unresolved instead of guessing an owner.
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) return '';
  if (/^[a-z]:/iu.test(path) || path.startsWith('//')) path = path.toLowerCase();
  return path;
}
