// SPDX-License-Identifier: Apache-2.0
/** Agent-groups projection and cleanup (doc 12 §F.2). This store never
 * launches runs; it groups the sessions already living in project worktrees. */
import { create } from 'zustand';
import { harnessClient, normalizeDirectory, type HarnessResult } from '../nnd/client.ts';
import type { Session } from '../nnd/types.ts';
import { listWorktrees, removeWorktree } from '../server-api.ts';

export interface AgentGroupWorktree { path: string; branch: string | null; }
export interface AgentGroupSession {
  session: Session;
  worktreePath: string;
  worktreeBranch: string | null;
}
export interface AgentGroup {
  name: string;
  sessions: AgentGroupSession[];
  lastActive: number;
  sessionCount: number;
}
export interface AgentGroupsSnapshot {
  status: 'idle' | 'loading' | 'ready' | 'error';
  groups: AgentGroup[];
  errors: string[];
  loadedAt: number;
}

const CACHE_MS = 30_000;
const LIST_CONCURRENCY = 5;

interface AgentGroupsStore {
  projects: Record<string, AgentGroupsSnapshot & { generation: number }>;
  loadGroups: (projectRoot: string, force?: boolean) => Promise<void>;
}

export const useAgentGroupsStore = create<AgentGroupsStore>((set, get) => ({
  projects: {},
  loadGroups: async (projectRoot, force = false) => {
    const key = normalizeDirectory(projectRoot);
    if (!key) return;
    const existing = get().projects[key];
    if (!force && existing?.status === 'ready' && Date.now() - existing.loadedAt < CACHE_MS) return;
    const generation = (existing?.generation ?? 0) + 1;
    set((state) => ({
      projects: {
        ...state.projects,
        [key]: {
          status: 'loading',
          groups: existing?.groups ?? [],
          errors: [],
          loadedAt: existing?.loadedAt ?? 0,
          generation,
        },
      },
    }));
    const worktrees = await listWorktrees(key).catch(() => null);
    if (worktrees === null) {
      setAgentResult(set, key, generation, [], ['Unable to list worktrees'], 'error');
      return;
    }
    const queue = worktrees.map((entry, index) => ({ entry, index }));
    const loaded: AgentGroupSession[] = [];
    const errors: string[] = [];
    await Promise.all(Array.from({ length: Math.min(LIST_CONCURRENCY, Math.max(worktrees.length, 1)) }, async () => {
      while (queue.length > 0) {
        const request = queue.shift();
        if (!request) continue;
        const directory = normalizeDirectory(request.entry.path);
        const result = await listDirectorySessions(directory, request.entry.path);
        if (result.error !== null) {
          errors.push(`${request.entry.path}: ${result.error}`);
          continue;
        }
        loaded.push(...result.sessions.map((session) => ({
          session,
          worktreePath: directory,
          worktreeBranch: request.entry.branch,
        })));
      }
    }));
    setAgentResult(set, key, generation, collectGroups(loaded), errors, errors.length > 0 ? 'error' : 'ready');
  },
}));

async function listDirectorySessions(directory: string, label: string, attempt = 1): Promise<{
  sessions: Session[];
  error: string | null;
}> {
  const result: HarnessResult<Session[]> = await harnessClient
    .listSessions({ directory, archived: true })
    .catch((thrown: unknown): HarnessResult<Session[]> => ({
      error: thrown instanceof Error ? thrown.message : String(thrown),
    }));
  if (result.data !== undefined) return { sessions: result.data, error: null };
  const error = result.error ?? 'session list failed';
  if (attempt >= 2) return { sessions: [], error };
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100 * attempt));
  try {
    return await listDirectorySessions(directory, label, attempt + 1);
  } catch (thrown) {
    return { sessions: [], error: thrown instanceof Error ? thrown.message : String(thrown) };
  }
}

function setAgentResult(
  set: (updater: (state: AgentGroupsStore) => Partial<AgentGroupsStore>) => void,
  projectRoot: string,
  generation: number,
  groups: AgentGroup[],
  errors: string[],
  status: 'ready' | 'error',
): void {
  set((state) => {
    const existing = state.projects[projectRoot];
    if (existing && existing.generation > generation) return {};
    return {
      projects: {
        ...state.projects,
        [projectRoot]: {
          status, groups, errors, loadedAt: Date.now(), generation,
        },
      },
    };
  });
}

export function parseAgentSessionTitle(title: string | undefined): {
  groupSlug: string;
  providerID: string;
  modelID: string;
  index: number;
} | null {
  const segments = (title ?? '').split('/').filter((segment) => segment.length > 0);
  if (segments.length < 3) return null;
  const groupSlug = segments[0]!;
  let index = 1;
  let modelEnd = segments.length;
  const lastSegment = segments[segments.length - 1]!;
  if (segments.length > 3 && /^\d+$/u.test(lastSegment)) {
    index = Number(lastSegment);
    modelEnd = segments.length - 1;
  }
  const providerID = segments[1]!;
  const modelID = segments.slice(2, modelEnd).join('/');
  if (modelID.length === 0) return null;
  return { groupSlug, providerID, modelID, index };
}

function normalizedWorktrees(sessions: readonly AgentGroupSession[]): Array<{ path: string; branch: string | null }> {
  const worktrees = new Map<string, string | null>();
  for (const entry of sessions) {
    const path = normalizeDirectory(entry.worktreePath);
    if (!path || worktrees.has(path)) continue;
    worktrees.set(path, entry.worktreeBranch);
  }
  return [...worktrees.entries()].map(([path, branch]) => ({ path, branch }));
}

export function collectGroups(input: readonly AgentGroupSession[]): AgentGroup[] {
  const byGroup = new Map<string, AgentGroupSession[]>();
  for (const entry of input) {
    const parsed = parseAgentSessionTitle(entry.session.title);
    if (parsed === null) continue;
    const group = byGroup.get(parsed.groupSlug) ?? [];
    group.push(entry);
    byGroup.set(parsed.groupSlug, group);
  }
  return [...byGroup.entries()].map(([name, sessions]) => {
    const ordered = [...sessions].sort((left, right) => {
      const leftParts = parseAgentSessionTitle(left.session.title)!;
      const rightParts = parseAgentSessionTitle(right.session.title)!;
      return leftParts.providerID.localeCompare(rightParts.providerID)
        || leftParts.modelID.localeCompare(rightParts.modelID)
        || leftParts.index - rightParts.index
        || left.session.id.localeCompare(right.session.id);
    });
    return {
      name,
      sessions: ordered,
      lastActive: Math.max(...ordered.map((entry) => entry.session.time.updated ?? 0), 0),
      sessionCount: ordered.length,
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

export interface DeleteAgentGroupServices {
  deleteSession: (input: { sessionID: string; directory: string }) => Promise<void>;
  removeWorktree: (input: { projectDirectory: string; worktreePath: string; worktreeBranch: string | null }) => Promise<{
    removed: true;
    branchError?: string;
  }>;
  disposeDirectory?: (directory: string) => void;
  currentDirectory: () => string;
  resetToProjectRoot: (projectDirectory: string) => void;
}

export interface DeleteAgentGroupResult {
  deletedSessionIds: string[];
  failedSessions: Array<{ sessionID: string; directory: string; error: string }>;
  removedWorktrees: string[];
  failedWorktrees: Array<{ path: string; error: string }>;
  failedBranches: Array<{ path: string; branch: string; error: string }>;
}

export async function deleteAgentGroupSessions(
  sessions: readonly AgentGroupSession[],
  options: { removeWorktrees?: boolean; projectDirectory: string },
  services: DeleteAgentGroupServices,
): Promise<DeleteAgentGroupResult> {
  const deleted: string[] = [];
  const failedSessions: DeleteAgentGroupResult['failedSessions'] = [];
  const failedWorktreePaths = new Set<string>();
  for (const entry of sessions) {
    const directory = normalizeDirectory(entry.session.directory ?? '');
    const sessionID = entry.session.id;
    try {
      await services.deleteSession({ sessionID, directory });
      deleted.push(sessionID);
    } catch (error) {
      failedWorktreePaths.add(normalizeDirectory(entry.worktreePath));
      failedSessions.push({ sessionID, directory, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const removedWorktrees: string[] = [];
  const failedWorktrees: DeleteAgentGroupResult['failedWorktrees'] = [];
  const failedBranches: DeleteAgentGroupResult['failedBranches'] = [];
  if (options.removeWorktrees === true) {
    for (const worktree of normalizedWorktrees(sessions)) {
      if (failedWorktreePaths.has(worktree.path)) continue;
      try {
        const outcome = await services.removeWorktree({
          projectDirectory: options.projectDirectory,
          worktreePath: worktree.path,
          worktreeBranch: worktree.branch,
        });
        removedWorktrees.push(worktree.path);
        if (worktree.branch !== null && outcome.branchError !== undefined) {
          failedBranches.push({ path: worktree.path, branch: worktree.branch, error: outcome.branchError });
        }
        services.disposeDirectory?.(worktree.path);
      } catch (error) {
        failedWorktrees.push({ path: worktree.path, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  const current = normalizeDirectory(services.currentDirectory());
  if (removedWorktrees.some((path) => isDirectoryInside(current, path))) {
    services.resetToProjectRoot(options.projectDirectory);
  }
  return { deletedSessionIds: deleted, failedSessions, removedWorktrees, failedWorktrees, failedBranches };
}

export function isDirectoryInside(directory: string, rootPath: string): boolean {
  const normalizedDirectory = normalizeDirectory(directory);
  const normalizedRootPath = normalizeDirectory(rootPath);
  return normalizedDirectory === normalizedRootPath || normalizedDirectory.startsWith(`${normalizedRootPath}/`);
}
