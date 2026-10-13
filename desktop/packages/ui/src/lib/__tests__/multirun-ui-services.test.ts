// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDirectoryStore } from '../../sync/child-store.ts';
import type { SyncEngine } from '../../sync/sync-engine.ts';
import { createWorktree, gitStatus, removeWorktree } from '../server-api.ts';
import { createMultiRunUiServices, registerWorktreeBackedRun } from '../multirun/ui-services.ts';
import type { GitWorktreeEntry } from '../server-api.ts';
import type { Session } from '../nnd/types.ts';

vi.mock('../server-api.ts', () => ({
  gitStatus: vi.fn(),
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
}));

const gitStatusMock = vi.mocked(gitStatus);
const createWorktreeMock = vi.mocked(createWorktree);
const removeWorktreeMock = vi.mocked(removeWorktree);

beforeEach(() => {
  gitStatusMock.mockReset();
  createWorktreeMock.mockReset();
  removeWorktreeMock.mockReset();
});

describe('multi-run UI services', () => {
  it('uses git-status truth and refuses only route failures', async () => {
    gitStatusMock.mockResolvedValue({ isGitRepository: false, branch: null, ahead: 0, behind: 0, files: [] });
    const services = makeServices();
    await expect(services.isGitRepository('C:/not-repo')).resolves.toBe(false);
    gitStatusMock.mockResolvedValue(null);
    await expect(services.isGitRepository('C:/offline')).rejects.toThrow('Unable to determine git status');
  });

  it('maps worktree outcomes and refuses unimplemented setup commands', async () => {
    const entry: GitWorktreeEntry = { path: 'C:/wt', head: null, branch: 'r/mock-model', detached: false, linked: true };
    createWorktreeMock.mockResolvedValue({ ok: true, worktree: entry });
    const services = makeServices();
    await expect(services.createWorktree({ directory: 'C:/repo', worktreeName: 'r/mock-model', branchName: 'r/mock-model' })).resolves.toEqual({ path: entry.path, branch: entry.branch });
    await expect(services.createWorktree({ directory: 'C:/repo', worktreeName: 'r', branchName: 'r', setupCommands: ['pnpm i'] })).rejects.toThrow('Worktree setup commands are not available yet');
    createWorktreeMock.mockResolvedValue({ ok: false, error: 'branch exists' });
    await expect(services.createWorktree({ directory: 'C:/repo', worktreeName: 'r', branchName: 'r' })).rejects.toThrow('branch exists');
  });

  it('removes worktrees and prefers branch deletion when one exists', async () => {
    removeWorktreeMock.mockResolvedValue({ ok: true, branch: 'r/mock-model' });
    const services = makeServices();
    await services.removeWorktree?.({ worktree: { path: 'C:/wt', branch: 'r/mock-model' } });
    expect(removeWorktreeMock).toHaveBeenCalledWith('C:/repo', 'C:/wt', true);
    removeWorktreeMock.mockResolvedValue({ ok: false, error: 'dirty' });
    await expect(services.removeWorktree?.({ worktree: { path: 'C:/wt', branch: 'r/mock-model' } })).rejects.toThrow('dirty');
  });

  it('sends files, shared agents, model variants, and snippets through the engine', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const services = makeServices({ send });
    await services.dispatchRun({
      run: {
        sessionID: 'session-1', session: {} as Session, title: 'g/demo/mock/model', directory: 'C:/wt',
        model: { providerID: 'mock', modelID: 'model', variant: 'high' }, prompt: 'do #sig', worktree: undefined,
      },
      expandedPrompt: 'do SNIPPET',
      agent: 'planner',
      files: [{ filename: 'a.png', mime: 'image/png', url: 'data:image/png;base64,AAAA' }],
    });
    expect(send).toHaveBeenCalledWith({
      directory: 'C:/wt', sessionID: 'session-1',
      parts: [
        { type: 'text', text: 'do SNIPPET' },
        { type: 'file', url: 'data:image/png;base64,AAAA', filename: 'a.png', mime: 'image/png' },
      ],
      model: { providerID: 'mock', modelID: 'model', variant: 'high' },
      agent: 'planner',
    });
  });

  it('labels isolated worktrees as standard while retaining the project directory', () => {
    const store = createDirectoryStore({ session: [] });
    const session = dummySession('C:/wt');
    store.setState({ session: [session] });
    registerWorktreeBackedRun(store, session, { path: 'C:/wt', branch: 'r/mock-model' });
    expect(store.getState().session[0]?.metadata).toEqual({
      createdFromBranch: 'r/mock-model', kind: 'standard', projectDirectory: 'C:/wt',
    });
    registerWorktreeBackedRun(store, dummySession('C:/repo'), undefined);
  });

  it('routes isolated metadata through the authoritative worktree child store', async () => {
    const worktreeStore = createDirectoryStore({ session: [] });
    const projectStore = createDirectoryStore();
    const session = dummySession('C:/wt');
    worktreeStore.setState({ session: [session] });
    const engine = {
      actions: { send: vi.fn() },
      routingDirectoryOf: vi.fn((sessionID: string) => sessionID === 'session-1' ? 'C:/wt' : undefined),
      childStoreOf: vi.fn((directory: string) => directory === 'C:/wt' ? worktreeStore : undefined),
      manager: { ensureChild: vi.fn() },
    } as unknown as SyncEngine;
    const services = createMultiRunUiServices({ directory: 'C:/repo', engine, store: projectStore });
    gitStatusMock.mockResolvedValue({ isGitRepository: true, branch: 'main', ahead: 0, behind: 0, files: [] });
    await services.isGitRepository('C:/repo');

    services.registerRun({
      sessionID: 'session-1',
      session,
      title: 'g/demo/mock/model',
      directory: 'C:/wt',
      model: { providerID: 'mock', modelID: 'model' },
      prompt: 'work',
      worktree: { path: 'C:/wt', branch: 'r/mock-model' },
    });

    expect(worktreeStore.getState().session[0]?.metadata).toEqual({
      createdFromBranch: 'main', kind: 'standard', projectDirectory: 'C:/repo',
    });
    expect(projectStore.getState().session).toHaveLength(0);
  });
});

function makeServices(overrides: { send?: ReturnType<typeof vi.fn> } = {}) {
  const engine = { actions: { send: overrides.send ?? vi.fn() } } as unknown as SyncEngine;
  return createMultiRunUiServices({ directory: 'C:/repo', engine, store: createDirectoryStore() });
}

function dummySession(directory: string): Session {
  return {
    id: 'session-1', slug: 'session', projectID: 'p', directory, title: 'g/demo/mock/model',
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    version: '1', time: { created: 1, updated: 1 }, metadata: {},
  };
}
