// SPDX-License-Identifier: Apache-2.0
/** P10-59 G.4 open guard: known previews, binary detection, line bound, errors. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const readFileText = vi.hoisted(() => vi.fn());
const readFileStat = vi.hoisted(() => vi.fn());
vi.mock('../files/api.ts', async (importOriginal) => ({ ...(await importOriginal<typeof import('../files/api.ts')>()), readFileStat, readFileText }));
import { MAX_OPEN_FILE_BYTES, MAX_OPEN_FILE_LINES, validateContextFileOpen } from '../context-file-open-guard.ts';
import { FileReadError } from '../files/api.ts';

describe('context file open guard', () => {
  beforeEach(() => {
    readFileStat.mockImplementation(async () => ({ isFile: true, exists: true, size: 32, mtimeMs: 0 }));
  });

  it('allows documented binary, document, and image extensions without reading them', async () => {
    for (const path of ['preview.pdf', 'shot.PNG', 'cache.exe', 'font.woff2']) {
      expect(await validateContextFileOpen(path, '/workspace')).toEqual({ status: 'ok' });
    }
    expect(readFileText).not.toHaveBeenCalled();
  });

  it('admits text, sniffs binary, and bounds line count', async () => {
    readFileText.mockImplementation(async () => 'plain text');
    expect(await validateContextFileOpen('notes.md', '/workspace')).toEqual({ status: 'ok' });
    expect(await validateContextFileOpen('data.txt', '/workspace')).toEqual({ status: 'ok' });
    readFileText.mockImplementation(async () => '\u0000not text');
    expect(await validateContextFileOpen('data.txt', '/workspace')).toEqual({ status: 'binary' });
    readFileText.mockImplementation(async () => Array.from({ length: MAX_OPEN_FILE_LINES + 1 },
      () => 'line').join('\n'));
    expect(await validateContextFileOpen('too-large.txt', '/workspace')).toEqual({ status: 'too-large' });
    expect(readFileText).toHaveBeenCalledWith('/workspace', 'too-large.txt', true);
  });

  it('classifies missing versus other failed reads as distinct failures', async () => {
    readFileText.mockRejectedValue(new FileReadError('not found', 404, 'not-found'));
    expect(await validateContextFileOpen('gone.txt', '/workspace')).toEqual({ status: 'missing' });
    readFileText.mockRejectedValue(new Error('read failed: EACCES'));
    expect(await validateContextFileOpen('denied.txt', '/workspace')).toEqual({ status: 'unreadable' });
  });

  it('does not let a not-found reason override a non-404 status', async () => {
    readFileText.mockRejectedValue(new FileReadError('not found', 500, 'not-found'));
    expect(await validateContextFileOpen('gone.txt', '/workspace')).toEqual({ status: 'unreadable' });
  });

  it('sniffs binary past the beginning, bounds oversized writes, and skips unavailable sizing', async () => {
    readFileText.mockClear();
    readFileStat.mockImplementation(async () => ({ isFile: true, exists: true, size: MAX_OPEN_FILE_BYTES + 1, mtimeMs: 0 }));
    expect(await validateContextFileOpen('huge.txt', '/workspace')).toEqual({ status: 'too-large' });
    expect(readFileText).not.toHaveBeenCalled();
    readFileStat.mockRejectedValue(new Error('stat failed'));
    readFileText.mockImplementation(async () => `${'x'.repeat(8192)}\u0000later binary`);
    expect(await validateContextFileOpen('late-binary.txt', '/workspace')).toEqual({ status: 'binary' });
  });

  it('rejects an empty path without reading', async () => {
    expect(await validateContextFileOpen('', '/workspace')).toEqual({ status: 'missing' });
  });

  it('rejects content beyond the byte cap when stale stat data misses growth', async () => {
    readFileStat.mockImplementation(async () => ({ isFile: true, exists: true, size: 0, mtimeMs: 0 }));
    readFileText.mockImplementation(async () => 'x'.repeat(MAX_OPEN_FILE_BYTES + 100000));
    expect(await validateContextFileOpen('stale-stat.txt', '/workspace')).toEqual({ status: 'too-large' });
  });
});
