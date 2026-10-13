// SPDX-License-Identifier: Apache-2.0
/**
 * Sidebar product actions against the mock PATCH channel (SLICE-C task 2):
 * rename = REAL updateSession({title}) PATCH; archive records time.archived;
 * restore records the 0 sentinel (truthiness classifier, inclusive lists).
 * The SIDEBAR drives these via engine actions; here the lifecycle layer is
 * asserted directly (the wiring point MainLayout renamed in place).
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('../../lib/runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));

import { runtimeFetch } from '../../lib/runtime-fetch.ts';
import { abortSessionAction, archiveSessionAction, renameSessionAction, restoreSessionAction } from '../session-lifecycle.ts';

const fetchMock = runtimeFetch as unknown as Mock;

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('session lifecycle PATCH channel (§5.22 sidebar product)', () => {
  it('rename sends PATCH {title} against /session/{id} and succeeds', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'ses_r1', title: 'New name', time: { created: 1, updated: 2 } }));
    await renameSessionAction('ses_r1', 'New name', 'D:/work');
    const call = fetchMock.mock.calls[0]!;
    expect(String(call[0])).toMatch(/\/session\/ses_r1(\?|$)/);
    expect(call[1]!.method).toBe('PATCH');
    expect(JSON.parse(String(call[1]!.body))).toEqual({ title: 'New name' });
  });

  it('archive records time.archived; restore records the 0 sentinel', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'ses_a1', time: { created: 1, updated: 2, archived: 7 } }));
    await archiveSessionAction('ses_a1', 'D:/work');
    const archive = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as { time: { archived: number } };
    expect(archive.time.archived).toBeGreaterThan(0);
    await restoreSessionAction('ses_a1', 'D:/work');
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))).toEqual({ time: { archived: 0 } });
  });

  it('a failed PATCH surfaces the harness error text', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'session not found' }, false));
    await expect(renameSessionAction('ses_x', 'y', 'D:/work')).rejects.toThrow('failed');
  });

  it('a failed abort surfaces the harness error instead of appearing successful', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'nnd_session_unavailable', message: 'Session unavailable' } }, false));
    await expect(abortSessionAction('ses_x', 'D:/work')).rejects.toThrow('failed');
  });
});
