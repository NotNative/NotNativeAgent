// SPDX-License-Identifier: Apache-2.0
/** Session directory to bounded storage-project ownership; explicit inputs only. */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

export interface OwnershipProject { id: string; worktree: string }
export interface OwnershipInputs {
  projectId?: string; directory?: string; managedChatsRoot?: string;
  projects?: readonly OwnershipProject[]; containsPath?: (directory: string, root: string) => boolean;
}
const MANAGED = 'openchamber-managed-chats';
const PATH_ID = /^[A-Za-z0-9_-]+$/u;

function samePathOrWithin(directory: string, root: string): boolean {
  if (relative(root, directory) === '') return true;
  const child = relative(root, directory);
  return child !== '' && !child.startsWith('..') && !isAbsolute(child);
}

export function normalizeOwnerPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const canonical = realpathSync(resolve(value));
    return isAbsolute(canonical) ? canonical : undefined;
  } catch { return undefined; }
}

export function projectIdForPath(directory: string): string {
  if (!isAbsolute(directory)) throw new Error('absolute project path is required');
  const digest = createHash('sha256').update(directory).digest('hex').slice(0, 12);
  const id = `path_${digest}`;
  if (!PATH_ID.test(id)) throw new Error('invalid storage project ID');
  return id;
}

function ownerIdForPathsDirectory(directory: string, projects: readonly OwnershipProject[]):
  string | undefined {
  return projects.find((project) => isAbsolute(project.worktree) &&
    samePathOrWithin(directory, project.worktree))?.id;
}

export function resolveMemoryOwnership(args: OwnershipInputs): string {
  if (args.containsPath !== undefined) {
    throw new Error('containsPath is not supported; use canonical filesystem containment');
  }
  const projectId = args.projectId ?? '';
  if (projectId && !PATH_ID.test(projectId)) {
    throw new Error('invalid project ID');
  }
  if (projectId && args.directory !== undefined) {
    throw new Error('provide either directory or projectID, not both');
  }
  if (projectId) return projectId;
  if (typeof args.directory !== 'string' || args.directory.trim() === '') {
    throw new Error('directory or projectID is required');
  }
  const directory = normalizeOwnerPath(args.directory);
  if (directory === undefined) throw new Error('workspace directory is required');
  const declaredOwner = ownerIdForPathsDirectory(directory, args.projects ?? []);
  if (declaredOwner !== undefined) return declaredOwner;
  if (args.managedChatsRoot !== undefined) {
    const root = normalizeOwnerPath(args.managedChatsRoot);
    if (root !== undefined && samePathOrWithin(directory, root)) return MANAGED;
  }
  return projectIdForPath(directory);
}

export const MANAGED_CHATS_OWNER = MANAGED;
