import { beforeEach, describe, expect, it, vi } from 'vitest';

const fileApi = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  searchWorkspaceFiles: vi.fn(),
  readFileStat: vi.fn(),
  readFileText: vi.fn(),
  writeFileText: vi.fn(),
  rawAssetUrl: vi.fn(),
  createDirectory: vi.fn(),
  deleteEntry: vi.fn(),
  renameEntry: vi.fn(),
}));

vi.mock('@notnative/ui/lib/files/server-api.ts', () => fileApi);

const gitApi = vi.hoisted(() => ({
  fetchGitStatus: vi.fn(), fetchGitBranches: vi.fn(), checkoutLocalBranch: vi.fn(),
  createLocalBranch: vi.fn(), fetchGitLog: vi.fn(), fetchGitDiff: vi.fn(),
  fetchGitFileDiff: vi.fn(), stageGitFiles: vi.fn(), unstageGitFiles: vi.fn(),
  discardGitFiles: vi.fn(), applyGitHunk: vi.fn(), commitChanges: vi.fn(), syncGitBranch: vi.fn(),
}));
vi.mock('@notnative/ui/lib/git/server-api.ts', () => gitApi);

import { createWebAPIs } from '../createWebAPIs.ts';

describe('web RuntimeAPIs files adapter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delegates the full files contract to the shared server client', async () => {
    const api = createWebAPIs();
    const entries = [{ name: 'src', path: 'src', isDirectory: true }];
    fileApi.listDirectory.mockResolvedValue(entries);
    fileApi.searchWorkspaceFiles.mockResolvedValue(entries);
    for (const method of ['readFileStat', 'readFileText', 'writeFileText', 'createDirectory', 'deleteEntry', 'renameEntry'] as const) {
      fileApi[method].mockResolvedValue(undefined);
    }
    fileApi.rawAssetUrl.mockReturnValue('/assets/logo.png');

    await expect(api.files.listDirectory('D:/workspace', 'src', true)).resolves.toBe(entries);
    await expect(api.files.search('D:/workspace', 'route', 40)).resolves.toBe(entries);
    await expect(api.files.readFileStat('D:/workspace', 'src/index.ts', true)).resolves.toBeUndefined();
    await expect(api.files.readFileText('D:/workspace', 'src/index.ts', true)).resolves.toBeUndefined();
    await expect(api.files.writeFileText('D:/workspace', 'src/index.ts', 'next', 'old')).resolves.toBeUndefined();
    expect(api.files.rawAssetUrl('D:/workspace', 'assets/logo.png', true)).toBe('/assets/logo.png');
    await expect(api.files.createDirectory('D:/workspace', 'src/new')).resolves.toBeUndefined();
    await expect(api.files.deleteEntry('D:/workspace', 'src/old.ts')).resolves.toBeUndefined();
    await expect(api.files.renameEntry('D:/workspace', 'src/old.ts', 'src/new.ts')).resolves.toBeUndefined();

    expect(fileApi.listDirectory).toHaveBeenCalledWith('D:/workspace', 'src', true);
    expect(fileApi.searchWorkspaceFiles).toHaveBeenCalledWith('D:/workspace', 'route', 40);
    expect(fileApi.readFileStat).toHaveBeenCalledWith('D:/workspace', 'src/index.ts', true);
    expect(fileApi.readFileText).toHaveBeenCalledWith('D:/workspace', 'src/index.ts', true);
    expect(fileApi.writeFileText).toHaveBeenCalledWith('D:/workspace', 'src/index.ts', 'next', 'old');
    expect(fileApi.rawAssetUrl).toHaveBeenCalledWith('D:/workspace', 'assets/logo.png', true);
    expect(fileApi.createDirectory).toHaveBeenCalledWith('D:/workspace', 'src/new');
    expect(fileApi.deleteEntry).toHaveBeenCalledWith('D:/workspace', 'src/old.ts');
    expect(fileApi.renameEntry).toHaveBeenCalledWith('D:/workspace', 'src/old.ts', 'src/new.ts');
  });
});

describe('web RuntimeAPIs Git adapter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delegates every supported scoped Git operation to the shared server client', async () => {
    const api = createWebAPIs();
    const status = { isGitRepository: true, branch: 'main', trackingBehind: 0, trackingAhead: 0, files: [] };
    gitApi.fetchGitStatus.mockResolvedValue(status);
    for (const method of Object.keys(gitApi) as (keyof typeof gitApi)[]) {
      if (method !== 'fetchGitStatus') gitApi[method].mockResolvedValue(undefined);
    }

    await expect(api.git.fetchGitStatus('D:/work', 'full')).resolves.toBe(status);
    await api.git.fetchGitBranches('D:/work');
    await api.git.checkoutLocalBranch('D:/work', 'feature', 'main');
    await api.git.createLocalBranch('D:/work', 'feature', 'main');
    await api.git.fetchGitLog('D:/work', 12);
    await api.git.fetchGitDiff('D:/work', 'a.ts', { staged: true, contextLines: 5 });
    await api.git.fetchGitFileDiff('D:/work', 'a.ts', false);
    await api.git.stageGitFiles('D:/work', ['a.ts']);
    await api.git.unstageGitFiles('D:/work', ['a.ts']);
    await api.git.discardGitFiles('D:/work', ['a.ts']);
    await api.git.applyGitHunk('D:/work', 'a.ts', 'patch', 'stage');
    await api.git.commitChanges('D:/work', 'commit');
    await api.git.syncGitBranch('D:/work');

    expect(gitApi.fetchGitStatus).toHaveBeenCalledWith('D:/work', 'full');
    expect(gitApi.fetchGitBranches).toHaveBeenCalledWith('D:/work');
    expect(gitApi.checkoutLocalBranch).toHaveBeenCalledWith('D:/work', 'feature', 'main');
    expect(gitApi.createLocalBranch).toHaveBeenCalledWith('D:/work', 'feature', 'main');
    expect(gitApi.fetchGitLog).toHaveBeenCalledWith('D:/work', 12);
    expect(gitApi.fetchGitDiff).toHaveBeenCalledWith('D:/work', 'a.ts', { staged: true, contextLines: 5 });
    expect(gitApi.fetchGitFileDiff).toHaveBeenCalledWith('D:/work', 'a.ts', false);
    expect(gitApi.stageGitFiles).toHaveBeenCalledWith('D:/work', ['a.ts']);
    expect(gitApi.unstageGitFiles).toHaveBeenCalledWith('D:/work', ['a.ts']);
    expect(gitApi.discardGitFiles).toHaveBeenCalledWith('D:/work', ['a.ts']);
    expect(gitApi.applyGitHunk).toHaveBeenCalledWith('D:/work', 'a.ts', 'patch', 'stage');
    expect(gitApi.commitChanges).toHaveBeenCalledWith('D:/work', 'commit');
    expect(gitApi.syncGitBranch).toHaveBeenCalledWith('D:/work');
  });
});
