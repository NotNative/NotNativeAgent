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
