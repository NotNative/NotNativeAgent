// SPDX-License-Identifier: Apache-2.0
/** P9-6a agent-groups store: loose title grouping, one-writer cache replacement,
 * partial worktree/session failures, and cleanup sequencing. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { harnessClient } from '../../nnd/client.ts';
import { useAgentGroupsStore, collectGroups, deleteAgentGroupSessions, parseAgentSessionTitle, type AgentGroupSession } from '../store.ts';
import type { Session } from '../../nnd/types.ts';

vi.mock('../../server-api.ts', () => ({
  listWorktrees: vi.fn(),
  removeWorktree: vi.fn(),
  createWorktree: vi.fn(),
}));

const serverApi = await import('../../server-api.ts');

beforeEach(() => {
  vi.clearAllMocks();
  useAgentGroupsStore.setState({ projects: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function session(input: { id: string; title: string; directory: string; updated: number }): Session {
  return {
    id: input.id, slug: input.title, projectID: 'p', directory: input.directory, title: input.title,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    version: '1', time: { created: input.updated, updated: input.updated },
  } as never;
}

function entry(session: Session, branch = 'feature/branch'): AgentGroupSession {
  return { session, worktreePath: session.directory, worktreeBranch: branch };
}

describe('agent-group projection', () => {
  it('parses loose multi-run titles and orders provider, model, then duplicate index', () => {
    expect(parseAgentSessionTitle('rework/openai/gpt')).toEqual({
      groupSlug: 'rework', providerID: 'openai', modelID: 'gpt', index: 1,
    });
    expect(parseAgentSessionTitle('rework/gemini/ultra/2')).toEqual({
      groupSlug: 'rework', providerID: 'gemini', modelID: 'ultra', index: 2,
    });
    expect(parseAgentSessionTitle('too/few')).toBeNull();
    expect(collectGroups([
      entry(session({ id: 'third', title: 'rework/openai/gpt/2', directory: 'wt3', updated: 3 })),
      entry(session({ id: 'first', title: 'rework/anthropic/claude', directory: 'wt1', updated: 9 })),
      entry(session({ id: 'second', title: 'rework/openai/gpt', directory: 'wt2', updated: 8 })),
    ]).map((group) => group.sessions.map((item) => item.session.id))).toEqual([['first', 'second', 'third']]);
  });

  it('loads worktrees with concurrency, retries failures, and preserves successful groups', async () => {
    vi.mocked(serverApi.listWorktrees).mockResolvedValue([
      { path: 'C:/first', branch: 'first' },
      { path: 'C:\\second', branch: 'second' },
      { path: 'C:/failed', branch: 'failed' },
    ] as never);
    const list = vi.spyOn(harnessClient, 'listSessions');
    const callsByDirectory = new Map<string, number>();
    list.mockImplementation(async (options) => {
      const directory = options?.directory ?? '';
      if (directory === 'C:/failed') {
        const calls = (callsByDirectory.get(directory) ?? 0) + 1;
        callsByDirectory.set(directory, calls);
        if (calls < 3) return { error: 'no connection' } as never;
      }
      return {
        data: directory === 'C:/second' ? [
          session({ id: 's2', title: 'rework/anthropic/claude', directory: 'C:/second', updated: 4 }),
        ] : [
          session({ id: 's1', title: 'rework/openai/gpt', directory: 'C:/first', updated: 9 }),
        ],
      } as never;
    });
    await useAgentGroupsStore.getState().loadGroups('C:/project');
    const result = useAgentGroupsStore.getState().projects['C:/project'];
    if (result === undefined) throw new Error('project snapshot missing');
    expect(result.status).toBe('error');
    expect(result.errors).toEqual(['C:/failed: no connection']);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.sessions).toHaveLength(2);
    expect(result.groups[0]?.lastActive).toBe(9);
    expect(callsByDirectory.get('C:/failed')).toBe(2);
  });

  it('does not serve an old generation over a newer force reload', async () => {
    let firstResolve: ((value: Array<{ path: string; branch: string }>) => void) | undefined;
    vi.mocked(serverApi.listWorktrees).mockResolvedValueOnce(new Promise<Array<{ path: string; branch: string }>>((resolvePromise) => { firstResolve = resolvePromise; }) as never);
    vi.mocked(serverApi.listWorktrees).mockResolvedValueOnce([
      { path: 'C:/new', branch: 'new' },
    ] as never);
    vi.spyOn(harnessClient, 'listSessions').mockResolvedValue({ data: [] } as never);
    const first = useAgentGroupsStore.getState().loadGroups('C:/project');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    const second = useAgentGroupsStore.getState().loadGroups('C:/project', true);
    await second;
    vi.mocked(serverApi.listWorktrees).mockResolvedValueOnce([
      { path: 'C:/obsolete', branch: 'obsolete' },
    ] as never);
    vi.spyOn(harnessClient, 'listSessions').mockResolvedValue({ data: [] } as never);
    firstResolve?.([{ path: 'C:/obsolete', branch: 'obsolete' }]);
    await first;
    const result = useAgentGroupsStore.getState().projects['C:/project'];
    if (result === undefined) throw new Error('project snapshot missing');
    expect(result.groups).toEqual([]);
  });
});

describe('agent-group cleanup', () => {
  it('deletes sessions sequentially, skips worktrees with failed sessions, and reports partial failure', async () => {
    const good = {
      session: session({ id: 'good', title: 'rework/openai/a', directory: 'C:/wt-good', updated: 2 }),
      worktreePath: 'C:/wt-good', worktreeBranch: 'good',
    };
    const bad = {
      session: session({ id: 'bad', title: 'rework/gemini/b', directory: 'C:/wt-bad', updated: 1 }),
      worktreePath: 'C:/wt-bad', worktreeBranch: 'bad',
    };
    const deleteSession = vi.fn().mockRejectedValueOnce(new Error('server offline')).mockResolvedValue(undefined);
    const removeWorktree = vi.fn().mockResolvedValue({ removed: true });
    const disposeDirectory = vi.fn();
    const resetToProjectRoot = vi.fn();
    const result = await deleteAgentGroupSessions(
      [bad, good],
      { removeWorktrees: true, projectDirectory: 'C:/project' },
      {
        deleteSession: (request) => deleteSession(request),
        removeWorktree,
        disposeDirectory,
        currentDirectory: () => 'C:/wt-bad',
        resetToProjectRoot,
      },
    );
    expect(result).toEqual({
      deletedSessionIds: ['good'],
      failedSessions: [{ sessionID: 'bad', directory: 'C:/wt-bad', error: 'server offline' }],
      removedWorktrees: ['C:/wt-good'],
      failedWorktrees: [],
      failedBranches: [],
    });
    expect(removeWorktree).toHaveBeenCalledWith({
      projectDirectory: 'C:/project',
      worktreePath: 'C:/wt-good',
      worktreeBranch: 'good',
    });
    expect(disposeDirectory).toHaveBeenCalledWith('C:/wt-good');
    expect(resetToProjectRoot).not.toHaveBeenCalled();
  });

  it('reports branch cleanup failure without discarding the removed worktree', async () => {
    const entryInput = {
      session: session({ id: 's', title: 'rework/openai/a', directory: 'C:/wt/run', updated: 2 }),
      worktreePath: 'C:/wt/run', worktreeBranch: 'feature/run',
    };
    const disposeDirectory = vi.fn();
    const resetToProjectRoot = vi.fn();
    const result = await deleteAgentGroupSessions(
      [entryInput],
      { removeWorktrees: true, projectDirectory: 'C:/project' },
      {
        deleteSession: vi.fn(),
        removeWorktree: vi.fn().mockResolvedValue({ removed: true, branchError: 'branch in use' }),
        disposeDirectory,
        currentDirectory: () => 'C:/wt/run/nested',
        resetToProjectRoot,
      },
    );
    expect(result).toMatchObject({
      removedWorktrees: ['C:/wt/run'],
      failedBranches: [{ path: 'C:/wt/run', branch: 'feature/run', error: 'branch in use' }],
    });
    expect(disposeDirectory).toHaveBeenCalledWith('C:/wt/run');
    expect(resetToProjectRoot).toHaveBeenCalledWith('C:/project');
  });

  it('resets a current descendant only after its worktree is removed', async () => {
    const entryInput = {
      session: session({ id: 's', title: 'rework/openai/a', directory: 'C:/wt/run', updated: 2 }),
      worktreePath: 'C:/wt/run', worktreeBranch: null,
    };
    const disposeDirectory = vi.fn();
    const resetToProjectRoot = vi.fn();
    const result = await deleteAgentGroupSessions(
      [entryInput],
      { removeWorktrees: true, projectDirectory: 'C:/project' },
      {
        deleteSession: vi.fn(),
        removeWorktree: vi.fn(),
        disposeDirectory,
        currentDirectory: () => 'C:/wt/run/nested',
        resetToProjectRoot,
      },
    );
    expect(result).toMatchObject({ deletedSessionIds: ['s'], removedWorktrees: ['C:/wt/run'] });
    expect(disposeDirectory).toHaveBeenCalledWith('C:/wt/run');
    expect(resetToProjectRoot).toHaveBeenCalledWith('C:/project');
  });
});
