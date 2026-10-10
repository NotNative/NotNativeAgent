// SPDX-License-Identifier: Apache-2.0
/** P10-52 BTW creation lifecycle tests (doc 15 §H.1 F8), org-store edition:
 * the marker and the parent link ride /api/session-org, only the title still
 * rides the session PATCH. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDirectoryStore } from '../../sync/child-store.ts';
import { harnessClient } from '../../lib/nnd/client.ts';
import { createBtwSession, clearBtwCreationGuard } from '../btw-actions.ts';
import type { Session } from '../../lib/nnd/types.ts';

vi.mock('../../lib/nnd/client.ts', () => ({
  normalizeDirectory: (value: string) => value.replace(/[\\/]+$/u, ''),
  harnessClient: { getSession: vi.fn(), updateSession: vi.fn(), deleteSession: vi.fn() },
}));

const orgRecords: Record<string, Record<string, Record<string, unknown>>> = {};
const orgPosts: { directory: string; sessionID: string; op: string; body: Record<string, unknown> }[] = [];
let failOrgPosts = false;

vi.mock('../../lib/runtime-fetch.ts', () => ({
  runtimeFetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes('/api/session-org')) throw new Error(`unexpected fetch ${url}`);
    if ((init?.method ?? 'GET') !== 'POST') {
      const directory = /directory=([^&]*)/u.exec(url)?.[1] ?? '';
      return Response.json({ version: 1, records: orgRecords[directory] ?? {} });
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & {
      directory: string; sessionID: string; op: string };
    orgPosts.push({ directory: body.directory, sessionID: body.sessionID, op: body.op, body });
    if (failOrgPosts) return Response.json({ error: 'org write failed' }, { status: 500 });
    const record = orgRecords[body.directory]?.[body.sessionID] ?? {};
    if (body.op === 'btw.setMarker') {
      record.btwMarker = { ...(body.marker as Record<string, unknown>),
        promoted: typeof body.promoted === 'boolean' ? body.promoted : false };
    }
    if (body.op === 'btw.setChild') record.btwChildOf = body.childSessionID;
    if (body.op === 'btw.clearChild' && record.btwChildOf === body.childSessionID) delete record.btwChildOf;
    if (body.op === 'btw.markPromoted' && record.btwMarker) record.btwMarker = { ...record.btwMarker as Record<string, unknown>, promoted: true };
    (orgRecords[body.directory] ??= {})[body.sessionID] = record;
    return Response.json({ success: true, record });
  }),
}));

const getSession = vi.mocked(harnessClient.getSession);
const updateSession = vi.mocked(harnessClient.updateSession);
const deleteSession = vi.mocked(harnessClient.deleteSession);

beforeEach(() => {
  getSession.mockReset();
  updateSession.mockReset();
  deleteSession.mockReset().mockResolvedValue({ data: true });
  for (const key of Object.keys(orgRecords)) delete orgRecords[key];
  orgPosts.length = 0;
  failOrgPosts = false;
  clearBtwCreationGuard();
});

describe('btw creation', () => {
  it('forks at the completed assistant, records marker and parent link, sends boundary', async () => {
    const parent = session('parent', 'D:/work', { title: 'Main' });
    const child = session('child', 'D:/work', {});
    const store = createDirectoryStore();
    store.setState({ session: [parent], message: { parent: [{
      id: 'a0', role: 'assistant', time: { created: 1, completed: 2 },
    }] } } as never);
    const childTitled = { ...child, title: 'btw: what' };
    getSession.mockResolvedValueOnce({ data: child as Session });
    updateSession.mockResolvedValueOnce({ data: childTitled as Session });
    const send = vi.fn(async () => undefined);
    const created = await createBtwSession({
      parent: { sessionID: 'parent', directory: 'D:/work', runtimeKey: 'D:/work\nparent' },
      question: ' what ', model: { providerID: 'mock', modelID: 'smart' }, store,
      engine: { actions: { fork: vi.fn(async () => 'child'), send,
        deleteSession: vi.fn(async () => undefined) } },
      isCurrent: () => true,
    });
    expect(created.title).toBe('btw: what');
    expect(orgPosts.map((post) => `${post.sessionID}:${post.op}`))
      .toEqual(['child:btw.setMarker', 'parent:btw.setChild']);
    expect(orgRecords['D:/work']?.child?.btwMarker).toEqual({
      originalSessionID: 'parent', boundaryMessageID: 'a0', promoted: false });
    expect(orgRecords['D:/work']?.parent?.btwChildOf).toBe('child');
    expect(updateSession).toHaveBeenCalledWith('child', { title: 'btw: what' }, { directory: 'D:/work' });
    expect(store.getState().session.some((item) => item.id === 'child')).toBe(true);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'child',
      parts: [expect.objectContaining({ synthetic: true }), { type: 'text', text: 'what' }],
    }));
  });

  it('continues BTW creation when the best-effort rename fails', async () => {
    const parent = session('parent', 'D:/work', {});
    const child = session('child', 'D:/work', {});
    const store = createDirectoryStore();
    store.setState({ session: [parent], message: { parent: [] } } as never);
    getSession.mockResolvedValueOnce({ data: child as Session });
    updateSession.mockRejectedValueOnce(new Error('rename failed'));
    const send = vi.fn(async () => undefined);
    const created = await createBtwSession({
      parent: { sessionID: 'parent', directory: 'D:/work', runtimeKey: 'D:/work\nparent' },
      question: 'what', model: { providerID: 'mock', modelID: 'smart' }, store,
      engine: { actions: { fork: vi.fn(async () => 'child'), send,
        deleteSession: vi.fn(async () => undefined) } },
      isCurrent: () => true,
    });
    expect(orgRecords['D:/work']?.child?.btwMarker).toEqual({
      originalSessionID: 'parent', boundaryMessageID: '', promoted: false });
    expect(send).toHaveBeenCalledOnce();
    expect(updateSession.mock.calls.some((call) => call[0] === 'child' && 'title' in (call[1] as object))).toBe(true);
  });

  it('unlinks and deletes the fork when the first send fails', async () => {
    const parent = session('parent', 'D:/work', { title: 'Main' });
    const child = session('child', 'D:/work', {});
    const store = createDirectoryStore();
    store.setState({ session: [parent], message: { parent: [] } } as never);
    const failedDelete = vi.fn(async () => undefined);
    getSession.mockResolvedValue({ data: child as Session });
    const send = vi.fn(async () => { throw new Error('send failed'); });
    await expect(createBtwSession({
      parent: { sessionID: 'parent', directory: 'D:/work', runtimeKey: 'D:/work\nparent' },
      question: 'what', model: { providerID: 'mock', modelID: 'smart' }, store,
      engine: { actions: {
        fork: vi.fn(async () => 'child'), send, deleteSession: failedDelete,
      } },
      isCurrent: () => true,
    })).rejects.toThrow('send failed');
    expect(failedDelete).toHaveBeenCalledWith('child', 'D:/work');
    expect(orgPosts.some((post) => post.sessionID === 'parent' && post.op === 'btw.clearChild'
      && post.body.childSessionID === 'child')).toBe(true);
  });

  it('deletes the fork when the marker write fails', async () => {
    const parent = session('parent', 'D:/work', {});
    const child = session('child', 'D:/work', {});
    const store = createDirectoryStore();
    store.setState({ session: [parent], message: { parent: [] } } as never);
    getSession.mockResolvedValueOnce({ data: child as Session });
    failOrgPosts = true;
    const engineDelete = vi.fn(async () => undefined);
    await expect(createBtwSession({
      parent: { sessionID: 'parent', directory: 'D:/work', runtimeKey: 'D:/work\nparent' },
      question: 'what', model: { providerID: 'mock', modelID: 'smart' }, store,
      engine: { actions: {
        fork: vi.fn(async () => 'child'), send: vi.fn(), deleteSession: engineDelete,
      } },
      isCurrent: () => true,
    })).rejects.toThrow('org write failed');
    expect(engineDelete).toHaveBeenCalledWith('child', 'D:/work');
  });

  it('aborts before any org write when the runtime key changes after fork', async () => {
    const parent = session('parent', 'D:/work', {});
    const store = createDirectoryStore();
    store.setState({ session: [parent] } as never);
    const engineDelete = vi.fn(async () => undefined);
    const runtimeDelete = vi.fn(async () => undefined);
      await expect(createBtwSession({
      parent: { sessionID: 'parent', directory: 'D:/work', runtimeKey: 'D:/work\nparent' },
      question: 'what', model: { providerID: 'mock', modelID: 'smart' }, store,
      engine: { actions: {
        fork: vi.fn(async () => 'child'), send: vi.fn(), deleteSession: runtimeDelete,
      } },
      isCurrent: () => false,
    })).rejects.toThrow('The btw runtime changed');
    expect(updateSession).not.toHaveBeenCalled();
    expect(orgPosts).toEqual([]);
    expect(runtimeDelete).not.toHaveBeenCalled();
  });

  it('unlinks without deleting when the runtime changes after the parent link', async () => {
    const parent = session('parent', 'D:/work', {});
    const child = session('child', 'D:/work', {});
    const store = createDirectoryStore();
    store.setState({ session: [parent], message: { parent: [] } } as never);
    getSession.mockResolvedValue({ data: child as Session });
    let call = 0;
    const send = vi.fn(async () => undefined);
    await expect(createBtwSession({
      parent: { sessionID: 'parent', directory: 'D:/work', runtimeKey: 'D:/work\nparent' },
      question: 'what', model: { providerID: 'mock', modelID: 'smart' }, store,
      engine: { actions: {
        fork: vi.fn(async () => 'child'), send, deleteSession: vi.fn(async () => undefined) } },
      isCurrent: () => call++ < 2, // true through fork and marker, false after the link
    })).rejects.toThrow('The btw runtime changed');
    expect(orgPosts.some((post) => post.sessionID === 'parent' && post.op === 'btw.clearChild')).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it('blocks a second creation while the parent guard is active', async () => {
    const store = createDirectoryStore();
    store.setState({ session: [session('parent', '/work', {})] } as never);
    let releaseFork: (value: string | PromiseLike<string>) => void = () => undefined;
    const first = createBtwSession({
      parent: { sessionID: 'parent', directory: 'D:/work', runtimeKey: 'D:/work\nparent' },
      question: 'first', model: { providerID: 'mock', modelID: 'smart' }, store,
      engine: { actions: {
        fork: vi.fn(() => new Promise<string>((resolve) => { releaseFork = resolve; })),
        send: vi.fn(), deleteSession: vi.fn(async () => undefined),
      } },
      isCurrent: () => true,
    }).catch(() => undefined);
    await Promise.resolve();
    await expect(createBtwSession({
      parent: { sessionID: 'parent', directory: 'D:/work', runtimeKey: 'D:/work\nparent' },
      question: 'second', model: { providerID: 'mock', modelID: 'smart' }, store,
      engine: { actions: { fork: vi.fn(), send: vi.fn(), deleteSession: vi.fn(async () => undefined) } },
      isCurrent: () => true,
    })).rejects.toThrow('A btw session is already starting');
    releaseFork('child');
    await first;
  });
});

function session(id: string, directory: string, metadata: Record<string, unknown>): Session {
  return { id, directory, metadata, title: '', time: { created: 0, updated: 0 } } as unknown as Session;
}
