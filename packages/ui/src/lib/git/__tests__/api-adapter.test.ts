import { beforeEach, describe, expect, it, vi } from 'vitest';

const { git, getRuntimeAPIs } = vi.hoisted(() => {
  const git = {
    fetchGitStatus: vi.fn(), fetchGitBranches: vi.fn(), checkoutLocalBranch: vi.fn(),
    createLocalBranch: vi.fn(), fetchGitLog: vi.fn(), fetchGitDiff: vi.fn(),
    fetchGitFileDiff: vi.fn(), stageGitFiles: vi.fn(), unstageGitFiles: vi.fn(),
    discardGitFiles: vi.fn(), applyGitHunk: vi.fn(), commitChanges: vi.fn(), syncGitBranch: vi.fn(),
  };
  return { git, getRuntimeAPIs: vi.fn(() => ({ git })) };
});

vi.mock('../../api/registry.ts', () => ({ getRuntimeAPIs }));

import * as gitFacade from '../api.ts';

describe('Git runtime facade', () => {
  beforeEach(() => vi.clearAllMocks());

  it('routes every supported Git operation through the registered runtime adapter', async () => {
    await gitFacade.fetchGitStatus('workspace', 'full');
    await gitFacade.fetchGitBranches('workspace');
    await gitFacade.checkoutLocalBranch('workspace', 'feature', 'main');
    await gitFacade.createLocalBranch('workspace', 'feature', 'main');
    await gitFacade.fetchGitLog('workspace', 25);
    await gitFacade.fetchGitDiff('workspace', 'src/a.ts', { staged: true, contextLines: 7 });
    await gitFacade.fetchGitFileDiff('workspace', 'src/a.ts', false);
    await gitFacade.stageGitFiles('workspace', ['src/a.ts']);
    await gitFacade.unstageGitFiles('workspace', ['src/a.ts']);
    await gitFacade.discardGitFiles('workspace', ['src/a.ts']);
    await gitFacade.applyGitHunk('workspace', 'src/a.ts', 'patch', 'discard');
    await gitFacade.commitChanges('workspace', 'message');
    await gitFacade.syncGitBranch('workspace');

    expect(getRuntimeAPIs).toHaveBeenCalledTimes(13);
    expect(git.fetchGitStatus).toHaveBeenCalledWith('workspace', 'full');
    expect(git.fetchGitBranches).toHaveBeenCalledWith('workspace');
    expect(git.checkoutLocalBranch).toHaveBeenCalledWith('workspace', 'feature', 'main');
    expect(git.createLocalBranch).toHaveBeenCalledWith('workspace', 'feature', 'main');
    expect(git.fetchGitLog).toHaveBeenCalledWith('workspace', 25);
    expect(git.fetchGitDiff).toHaveBeenCalledWith('workspace', 'src/a.ts', { staged: true, contextLines: 7 });
    expect(git.fetchGitFileDiff).toHaveBeenCalledWith('workspace', 'src/a.ts', false);
    expect(git.stageGitFiles).toHaveBeenCalledWith('workspace', ['src/a.ts']);
    expect(git.unstageGitFiles).toHaveBeenCalledWith('workspace', ['src/a.ts']);
    expect(git.discardGitFiles).toHaveBeenCalledWith('workspace', ['src/a.ts']);
    expect(git.applyGitHunk).toHaveBeenCalledWith('workspace', 'src/a.ts', 'patch', 'discard');
    expect(git.commitChanges).toHaveBeenCalledWith('workspace', 'message');
    expect(git.syncGitBranch).toHaveBeenCalledWith('workspace');
  });
});
