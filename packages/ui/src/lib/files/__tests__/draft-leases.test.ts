// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));

import { runtimeFetch } from '../../runtime-fetch.ts';
import { __resetDraftLeasesForTests, forgetDraftLease, inspectDraftLeaseOnDisk, readDraftLease, rememberDraftLease, type DraftLease } from '../draft-leases.ts';

const fetchMock = vi.mocked(runtimeFetch);
const lease: DraftLease = { draft: 'new text\n', baseline: 'old text\n', lineEnding: '\n',
  stat: { size: 9, mtimeMs: 100 }, autoSaveEnabled: true };

beforeEach(() => { __resetDraftLeasesForTests(); fetchMock.mockReset(); });

describe('session file draft leases', () => {
  it('isolates runtime, workspace and path, and cannot clear a newer draft with an old save', () => {
    rememberDraftLease('local', '/a', '/a/file.ts', lease);
    expect(readDraftLease('remote', '/a', '/a/file.ts')).toBeNull();
    expect(readDraftLease('local', '/b', '/a/file.ts')).toBeNull();
    expect(readDraftLease('local', '/a', '/a/other.ts')).toBeNull();
    rememberDraftLease('local', '/a', '/a/file.ts', { ...lease, draft: 'newer edit\n' });
    forgetDraftLease('local', '/a', '/a/file.ts', lease.draft);
    expect(readDraftLease('local', '/a', '/a/file.ts')?.draft).toBe('newer edit\n');
  });

  it('compares a fresh baseline even when size and mtime were reused', async () => {
    fetchMock.mockImplementation(async (input) => String(input).includes('/api/fs/stat')
      ? { ok: true, json: async () => ({ path: '/a/file.ts', isFile: true, size: 9, mtimeMs: 100 }) } as Response
      : new Response('not text\n', { status: 200 }));
    expect(await inspectDraftLeaseOnDisk('/a', '/a/file.ts', lease)).toBe('changed');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/fs/read'))).toBe(true);
  });
});
