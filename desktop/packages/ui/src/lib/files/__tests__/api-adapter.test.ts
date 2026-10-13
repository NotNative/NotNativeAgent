import { beforeEach, describe, expect, it, vi } from 'vitest';

const { files, getRuntimeAPIs } = vi.hoisted(() => {
  const files = {
    listDirectory: vi.fn(), search: vi.fn(), readFileStat: vi.fn(), readFileText: vi.fn(),
    writeFileText: vi.fn(), rawAssetUrl: vi.fn(), createDirectory: vi.fn(),
    deleteEntry: vi.fn(), renameEntry: vi.fn(),
  };
  return { files, getRuntimeAPIs: vi.fn(() => ({ files })) };
});

vi.mock('../../api/registry.ts', () => ({ getRuntimeAPIs }));

import * as fileFacade from '../api.ts';

describe('files runtime facade', () => {
  beforeEach(() => vi.clearAllMocks());

  it('routes every shared file operation through the registered runtime adapter', async () => {
    await fileFacade.listDirectory('workspace', 'src', true);
    await fileFacade.searchWorkspaceFiles('workspace', 'needle', 20);
    await fileFacade.readFileStat('workspace', 'src/a.ts', true);
    await fileFacade.readFileText('workspace', 'src/a.ts', true);
    await fileFacade.writeFileText('workspace', 'src/a.ts', 'new', 'old');
    fileFacade.rawAssetUrl('workspace', 'image.png', true);
    await fileFacade.createDirectory('workspace', 'src/new');
    await fileFacade.deleteEntry('workspace', 'src/old.ts');
    await fileFacade.renameEntry('workspace', 'src/a.ts', 'src/b.ts');

    expect(getRuntimeAPIs).toHaveBeenCalledTimes(9);
    expect(files.listDirectory).toHaveBeenCalledWith('workspace', 'src', true);
    expect(files.search).toHaveBeenCalledWith('workspace', 'needle', 20);
    expect(files.readFileStat).toHaveBeenCalledWith('workspace', 'src/a.ts', true);
    expect(files.readFileText).toHaveBeenCalledWith('workspace', 'src/a.ts', true);
    expect(files.writeFileText).toHaveBeenCalledWith('workspace', 'src/a.ts', 'new', 'old');
    expect(files.rawAssetUrl).toHaveBeenCalledWith('workspace', 'image.png', true);
    expect(files.createDirectory).toHaveBeenCalledWith('workspace', 'src/new');
    expect(files.deleteEntry).toHaveBeenCalledWith('workspace', 'src/old.ts');
    expect(files.renameEntry).toHaveBeenCalledWith('workspace', 'src/a.ts', 'src/b.ts');
  });
});
