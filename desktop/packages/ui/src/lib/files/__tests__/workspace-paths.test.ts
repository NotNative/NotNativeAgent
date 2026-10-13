// SPDX-License-Identifier: Apache-2.0
/** Workspace path bridge (doc 06 §2.2): prefix stripping + separators. */
import { describe, expect, it } from 'vitest';
import { normalizeSeparators, parentDirOfPath, workspaceRelativePath } from '../workspace-paths.ts';

describe('workspaceRelativePath', () => {
  it('strips the root prefix across separators and case-insensitive drive letters', () => {
    expect(workspaceRelativePath('D:/repo', 'D:\\repo\\src\\a.ts')).toBe('src/a.ts');
    expect(workspaceRelativePath('c:/repo', 'C:\\repo\\a.ts')).toBe('a.ts');
    expect(workspaceRelativePath('/repo', '/repo')).toBe('');
    expect(workspaceRelativePath('/repo', '/outside/a.ts')).toBeNull();
  });

  it('normalizes separators and trailing slashes', () => {
    expect(normalizeSeparators('D:/repo/')).toBe('D:/repo');
    expect(normalizeSeparators('\\\\host\\share\\')).toBe('//host/share');
    expect(parentDirOfPath('src/deep/a.ts')).toBe('src/deep');
    expect(parentDirOfPath('a.ts')).toBe('.');
  });
});
