// SPDX-License-Identifier: Apache-2.0
/** P10-60 G.5 grant cache and desktop-only transport lifecycle. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OUTSIDE_FILE_GRANT_RENEWAL_MS,
  resetOutsideFileGrantCache,
  resolveOutsideFileReadOptions,
} from '../outside-file-grants.ts';
import type { OutsideFileGrantHost } from '../outside-file-grants.ts';

function host(reply?: unknown, error?: unknown): OutsideFileGrantHost | undefined {
  const result = {
    requestExistingFileAccess: async () => {
      if (error) throw error;
      return reply as { success?: boolean; path?: unknown; outsideFileGrant?: unknown; expiresAt?: unknown };
    },
  };
  return result;
}

beforeEach(() => { resetOutsideFileGrantCache(); vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(() => { resetOutsideFileGrantCache(); vi.useRealTimers(); });

describe('outside file grants', () => {
  it('uses no grant for disabled, missing host, missing path, and inside workspaces', async () => {
    expect(await resolveOutsideFileReadOptions('/out/file.txt', '/work', false, host({ success: true }))).toEqual({ allowOutsideWorkspace: false });
    expect(await resolveOutsideFileReadOptions('/out/file.txt', '', true, host({ success: true }))).toEqual({ allowOutsideWorkspace: false });
    expect(await resolveOutsideFileReadOptions('/out/file.txt', '/work', true, undefined)).toEqual({ allowOutsideWorkspace: false });
    expect(await resolveOutsideFileReadOptions('', '/work', true, host({ success: true }))).toEqual({ allowOutsideWorkspace: false });
    expect(await resolveOutsideFileReadOptions('/work/file.txt', '/work', true, host({ success: true }))).toEqual({ allowOutsideWorkspace: false });
  });

  it('requires an absolute requested path and normalizes the workspace root', async () => {
    const request = vi.fn();
    const hostInstance = { requestExistingFileAccess: request };
    expect(await resolveOutsideFileReadOptions('out/file.txt', '/work', true, hostInstance)).toEqual({ allowOutsideWorkspace: false });
    expect(await resolveOutsideFileReadOptions('C:file.txt', '/work', true, hostInstance)).toEqual({ allowOutsideWorkspace: false });
    expect(await resolveOutsideFileReadOptions('D:/work/inside.txt', ' d:/work ', true, hostInstance)).toEqual({ allowOutsideWorkspace: false });
    expect(request).not.toHaveBeenCalled();
  });

  it('normalizes and caches grants across request and granted-path aliases', async () => {
    const request = vi.fn(async () => ({ success: true, path: 'd:/grant/file.txt', outsideFileGrant: 'token', expiresAt: Date.now() + 60_000 }));
    const hostInstance = { requestExistingFileAccess: request };
    const first = await resolveOutsideFileReadOptions('D:/out/file.txt/', '/work', true, hostInstance);
    const alias = await resolveOutsideFileReadOptions('d:\\out\\file.txt', '/work', true, hostInstance);
    const canonical = await resolveOutsideFileReadOptions('D:/grant/file.txt', '/work', true, hostInstance);
    expect(first).toEqual({ allowOutsideWorkspace: true, outsideFileGrant: 'token' });
    expect(alias).toEqual(first);
    expect(canonical).toEqual(first);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenNthCalledWith(1, 'D:/out/file.txt');
  });

  it('deduplicates concurrent and alias requests', async () => {
    const request = vi.fn(async () => ({ success: true, path: '/file', outsideFileGrant: 'shared', expiresAt: Date.now() + 60_000 }));
    const hostInstance = { requestExistingFileAccess: request };
    const [first, second, third] = await Promise.all([
      resolveOutsideFileReadOptions('/file', '/work', true, hostInstance),
      resolveOutsideFileReadOptions('/file', '/work', true, hostInstance),
      resolveOutsideFileReadOptions('/file/', '/work', true, hostInstance),
    ]);
    expect(first).toEqual(second);
    expect(third).toEqual(first);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('transparently re-mints a grant after its renewal threshold', async () => {
    let calls = 0;
    const request = vi.fn(async () => {
      calls += 1;
      return {
        success: true,
        path: '/file',
        outsideFileGrant: calls === 1 ? 'old' : 'new',
        expiresAt: Date.now() + (calls === 1 ? OUTSIDE_FILE_GRANT_RENEWAL_MS + 100 : 60_000),
      };
    });
    const hostInstance = { requestExistingFileAccess: request };
    expect(await resolveOutsideFileReadOptions('/file', '/work', true, hostInstance)).toEqual({ allowOutsideWorkspace: true, outsideFileGrant: 'old' });
    vi.advanceTimersByTime(1);
    expect(await resolveOutsideFileReadOptions('/file', '/work', true, hostInstance)).toEqual({ allowOutsideWorkspace: true, outsideFileGrant: 'old' });
    vi.advanceTimersByTime(99);
    expect(await resolveOutsideFileReadOptions('/file', '/work', true, hostInstance)).toEqual({ allowOutsideWorkspace: true, outsideFileGrant: 'new' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('honors transport failures, failed approvals, malformed replies, and nonfuture expiries', async () => {
    const request = vi.fn(async () => { throw new Error('bridge disconnected'); });
    expect(await resolveOutsideFileReadOptions('/out/file', '/work', true, { requestExistingFileAccess: request })).toEqual({ allowOutsideWorkspace: false });
    expect(request).toHaveBeenCalledTimes(1);
    let index = 0;
    const malformed = (offset: number) => `/out/malformed-${offset + index++}.txt`;
    expect(await resolveOutsideFileReadOptions(malformed(0), '/work', true, host())).toEqual({ allowOutsideWorkspace: false });
    expect(await resolveOutsideFileReadOptions(malformed(0), '/work', true, host({ success: false, path: '/file', outsideFileGrant: 'token', expiresAt: Date.now() + 1 }))).toEqual({ allowOutsideWorkspace: false });
    expect(await resolveOutsideFileReadOptions(malformed(0), '/work', true, host({ success: true, path: 12, outsideFileGrant: 'token', expiresAt: Date.now() + 1 }))).toEqual({ allowOutsideWorkspace: false });
    expect(await resolveOutsideFileReadOptions(malformed(0), '/work', true, host({ success: true, path: '/file', outsideFileGrant: '', expiresAt: Date.now() + 1 }))).toEqual({ allowOutsideWorkspace: false });
    expect(await resolveOutsideFileReadOptions(malformed(0), '/work', true, host({ success: true, path: '/file', outsideFileGrant: 'token', expiresAt: Date.now() }))).toEqual({ allowOutsideWorkspace: false });
    expect(await resolveOutsideFileReadOptions(malformed(0), '/work', true, host({ success: true, path: '/file', outsideFileGrant: 'token', expiresAt: Number.MAX_SAFE_INTEGER + 1 }))).toEqual({ allowOutsideWorkspace: false });
    const valid = await resolveOutsideFileReadOptions('/out/valid', '/work', true, host({ success: true, path: '/file', outsideFileGrant: 'later-token', expiresAt: Date.now() + 1 }));
    expect(valid).toEqual({ allowOutsideWorkspace: true, outsideFileGrant: 'later-token' });
  });
});
