// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMultiRun,
  type CreateMultiRunResult,
  type MultiRunDispatchRequest,
  type MultiRunServices,
} from '../multirun/create.ts';
import type { Session } from '../nnd/types.ts';

function createTestSession(id: string, title: string, directory: string): Session {
  return {
    id, slug: title, projectID: 'p', directory, title,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    version: '1', time: { created: 1, updated: 1 },
  };
}

type TestServices = MultiRunServices & {
  createWorktree: ReturnType<typeof vi.fn>;
  createSession: ReturnType<typeof vi.fn>;
  registerRun: ReturnType<typeof vi.fn>;
  dispatchRun: ReturnType<typeof vi.fn>;
};

function services(overrides: Partial<MultiRunServices> = {}): TestServices {
  const createWorktree = vi.fn(async ({ worktreeName, branchName }: { worktreeName: string; branchName: string }) => ({
    path: `D:/wt/${worktreeName}`,
    branch: branchName,
  }));
  const createSession = vi.fn(async ({ title, directory }: { title: string; directory: string }) => createTestSession(
    `s_${title}`, title, directory,
  ));
  const registerRun = vi.fn();
  const dispatchRun = vi.fn().mockResolvedValue(undefined);
  return {
    directory: () => 'D:/project',
    isGitRepository: vi.fn(async () => true),
    createWorktree,
    createSession,
    registerRun,
    expandPrompt: (text) => text,
    dispatchRun,
    ...overrides,
  } as TestServices;
}

const MODEL = { providerID: 'anthropic', modelID: 'sonnet' };
const group = { prompt: 'solve it', models: [MODEL] };

describe('multi-run creation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes worktree setup context forward and dispatches with shared launch context', async () => {
    const createdServices = services({
      saveWorktreeSetupCommands: vi.fn().mockResolvedValue(undefined),
    });
    const file = { filename: 'a.png', mime: 'image/png', url: 'data:image/png;base64,AAAA' };
    await createMultiRun({
      name: 'Rework UI!!',
      groups: [{ prompt: ' first ', models: [MODEL, { ...MODEL, variant: 'high' }] }],
      agent: 'planner',
      worktreeBaseBranch: 'main',
      setupCommands: ['pnpm i'],
      files: [file],
    }, createdServices);

    expect(getWorktreeNames(createdServices.createWorktree.mock.calls)).toEqual([
      'rework-ui/anthropic-sonnet',
      'rework-ui/anthropic-sonnet/2',
    ]);
    for (const call of createdServices.createWorktree.mock.calls) {
      expect(call[0]).toMatchObject({ startRef: 'main', setupCommands: ['pnpm i'] });
    }
    expect(createdServices.saveWorktreeSetupCommands).toHaveBeenCalledWith('D:/project', ['pnpm i']);
    expect(getRequest(createdServices.dispatchRun.mock.calls[0])).toMatchObject({
      expandedPrompt: ' first ',
      agent: 'planner',
      files: [file],
    });
    expect(getRequest(createdServices.dispatchRun.mock.calls[0])?.run.model.variant).toBeUndefined();
    expect(getRequest(createdServices.dispatchRun.mock.calls[1])?.run.model.variant).toBe('high');
  });

  it('returns immediately while dispatch remains pending', async () => {
    const createdServices = services();
    createdServices.dispatchRun.mockImplementation(() => new Promise<void>(() => {}));
    let result: CreateMultiRunResult | null = null;
    const pending = createMultiRun({
      name: 'demo',
      groups: [{ prompt: 'solve it', models: [MODEL, MODEL] }],
    }, createdServices)
      .then((value) => {
        result = value;
        return value;
      });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(createdServices.dispatchRun).toHaveBeenCalledTimes(2);

    await pending;
    expect(result).toStrictEqual({
      groupSlug: 'demo',
      firstSessionId: 's_demo/anthropic/sonnet',
      sessionIds: ['s_demo/anthropic/sonnet', 's_demo/anthropic/sonnet/2'],
    });
  });

  it('uses HEAD as the worktree default and non-isolated titles for non-git projects', async () => {
    const notGit = services({ isGitRepository: vi.fn(async () => false) });
    await createMultiRun({ name: 'demo', groups: [group] }, notGit);
    expect(notGit.createWorktree).not.toHaveBeenCalled();
    expect(notGit.registerRun.mock.calls[0]?.[0]?.title).toBe('demo/anthropic/sonnet');
    expect(notGit.registerRun.mock.calls[0]?.[0]?.directory).toBe('D:/project');

    const git = services();
    await createMultiRun({ name: 'demo', groups: [group] }, git);
    expect((git.createWorktree.mock.calls[0]?.[0] as { startRef?: string }).startRef).toBe('HEAD');
  });

  it('uses group titles across groups and continues after a run creation failure', async () => {
    const createdServices = services();
    createdServices.createWorktree.mockImplementation(async ({ worktreeName }) => {
      if (worktreeName.endsWith('/2')) throw new Error('duplicate refused');
      return { path: `D:/wt/${worktreeName}`, branch: worktreeName };
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await createMultiRun({
      name: 'demo',
      groups: [group, { ...group, models: [MODEL, MODEL] }],
    }, createdServices);
    expect(result).toStrictEqual({
      groupSlug: 'demo',
      firstSessionId: 's_g1/demo/anthropic/sonnet',
      sessionIds: ['s_g1/demo/anthropic/sonnet', 's_g2/demo/anthropic/sonnet'],
    });
    expect(warn).toHaveBeenCalledWith('anthropic/sonnet (group g2): duplicate refused');
  });

  it('keeps synchronously failed dispatch expansion detached from session creation', async () => {
    const createdServices = services();
    createdServices.expandPrompt = () => {
      throw new Error('snippets unavailable');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await createMultiRun({ name: 'demo', groups: [group, group] }, createdServices);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.sessionIds).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith('g1/demo/anthropic/sonnet: snippets unavailable');
  });

  it('rolls back a created worktree when its session flow fails', async () => {
    const createdServices = services();
    createdServices.createSession = vi.fn(async ({ directory }: { directory: string }) => {
      if (directory.startsWith('D:/wt/')) throw new Error('session service down');
      throw new Error('unreachable');
    });
    const removeWorktree = vi.fn().mockResolvedValue(undefined);
    createdServices.removeWorktree = removeWorktree;
    const result = createMultiRun({ name: 'demo', groups: [group] }, createdServices);
    await expect(result).rejects.toThrow('Failed to create any sessions');
    expect(removeWorktree).toHaveBeenCalledWith({
      worktree: { path: 'D:/wt/demo/anthropic-sonnet', branch: 'demo/anthropic-sonnet' },
    });
  });

  it('rejects invalid schemas without touching services', async () => {
    const createdServices = services();
    await expect(createMultiRun({ name: '--', groups: [group] }, createdServices)).rejects.toThrow('Enter a valid multi-run name');
    await expect(createMultiRun({
      name: 'demo',
      groups: [{ prompt: '', models: [MODEL] }],
    }, createdServices)).rejects.toThrow('Each group needs a non-empty prompt');
    await expect(createMultiRun({
      name: 'demo',
      groups: [group],
      files: [{ filename: 'f', mime: 'text/plain', url: '' }],
    }, createdServices)).rejects.toThrow('File attachments require a name and data URL');
    expect(createdServices.createSession).not.toHaveBeenCalled();
  });
});

function getRequest(call: unknown[] | undefined): MultiRunDispatchRequest | undefined {
  return call?.[0] as MultiRunDispatchRequest | undefined;
}

function getWorktreeNames(calls: unknown[]): string[] {
  return calls.map((call) => (call as [{ worktreeName: string }, ...unknown[]])[0].worktreeName);
}
