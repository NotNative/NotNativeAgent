import { beforeEach, describe, expect, it, vi } from 'vitest';

const fileApi = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  searchWorkspaceFiles: vi.fn(),
  createDirectory: vi.fn(),
}));

vi.mock('@notnative/ui/lib/files/api.ts', () => fileApi);

import { createWebAPIs } from '../createWebAPIs.ts';

describe('web RuntimeAPIs files adapter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delegates scoped directory listing, search, and creation to the shared files client', async () => {
    const api = createWebAPIs();
    const entries = [{ name: 'src', path: 'src', isDirectory: true }];
    fileApi.listDirectory.mockResolvedValue(entries);
    fileApi.searchWorkspaceFiles.mockResolvedValue(entries);
    fileApi.createDirectory.mockResolvedValue(undefined);

    await expect(api.files.listDirectory('D:/workspace', 'src', true)).resolves.toBe(entries);
    await expect(api.files.search('D:/workspace', 'route', 40)).resolves.toBe(entries);
    await expect(api.files.createDirectory('D:/workspace', 'src/new')).resolves.toBeUndefined();

    expect(fileApi.listDirectory).toHaveBeenCalledWith('D:/workspace', 'src', true);
    expect(fileApi.searchWorkspaceFiles).toHaveBeenCalledWith('D:/workspace', 'route', 40);
    expect(fileApi.createDirectory).toHaveBeenCalledWith('D:/workspace', 'src/new');
  });
});
