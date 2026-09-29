// SPDX-License-Identifier: Apache-2.0
/** P10-52 BTW creation lifecycle tests (doc 15 §H.1 F8). */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDirectoryStore } from '../../sync/child-store.ts';
import { harnessClient } from '../../lib/nnd/client.ts';
import { createBtwSession, clearBtwCreationGuard } from '../btw-actions.ts';
import { metadataLinkBtwParent, metadataWithBtwFork } from '../btw-context.ts';
import type { Session } from '../../lib/nnd/types.ts';

vi.mock('../../lib/nnd/client.ts', () => ({
  normalizeDirectory: (value: string) => value.replace(/[\\/]+$/u, ''),
  harnessClient: { getSession: vi.fn(), updateSession: vi.fn(), deleteSession: vi.fn() },
}));

const getSession = vi.mocked(harnessClient.getSession);
const updateSession = vi.mocked(harnessClient.updateSession);
const deleteSession = vi.mocked(harnessClient.deleteSession);

beforeEach(() => {
  getSession.mockReset();
  updateSession.mockReset();
  deleteSession.mockReset().mockResolvedValue({ data: true });
  clearBtwCreationGuard();
});

describe('btw creation', () => {
  it('forks at the completed assistant, links parent, inserts child, and sends boundary', async () => {
    const parent = session('parent', 'D:/work', { title: 'Main' });
    const child = session('child', 'D:/work', {});
    const store = createDirectoryStore();
    store.setState({ session: [parent], message: { parent: [{
      id: 'a0', role: 'assistant', time: { created: 1, completed: 2 },
    }] } } as never);
    const childMarked = { ...child, metadata: metadataWithBtwFork({}, { originalSessionID: 'parent', boundaryMessageID: 'a0' }) };
    const childTitled = { ...childMarked, title: 'btw: what' };
    const parentLinked = { ...parent, metadata: metadataLinkBtwParent(parent.metadata ?? {}, 'child') };
    updateSession.mockImplementationOnce(async () => ({ data: childMarked as Session }));
    updateSession.mockImplementationOnce(async () => ({ data: childTitled as Session }));
    updateSession.mockImplementationOnce(async () => ({ data: parentLinked as Session }));
    getSession.mockResolvedValueOnce({ data: child as Session });
    updateSession.mockImplementationOnce(async () => ({ data: parentLinked as Session }));
    getSession.mockResolvedValueOnce({ data: parent as Session });
    const send = vi.fn(async () => undefined);
    const created = await createBtwSession({
      parent: { sessionID: 'parent', directory: 'D:/work', runtimeKey: 'D:/work\nparent' },
      question: ' what ', model: { providerID: 'mock', modelID: 'smart' }, store,
      engine: { actions: { fork: vi.fn(async () => 'child'), send,
        deleteSession: vi.fn(async () => undefined) } },
      isCurrent: () => true,
    });
expect(created.title).toBe('btw: what');
expect(created.metadata?.title).toBeUndefined();
    expect(created.metadata?.openchamber).toEqual({ kind: 'btw', originalSessionID: 'parent', btwBoundaryMessageID: 'a0' });
    expect(updateSession).toHaveBeenNthCalledWith(3, 'parent', { metadata: parentLinked.metadata }, { directory: 'D:/work' });
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
    const childMarked = { ...child, metadata: metadataWithBtwFork({}, { originalSessionID: 'parent', boundaryMessageID: null }) };
    getSession.mockResolvedValueOnce({ data: child as Session });
    getSession.mockResolvedValueOnce({ data: parent as Session });
    updateSession.mockImplementation(async (id, patch) => {
      if (id === 'child') {
        if ('title' in (patch as object)) throw new Error('rename failed');
        return { data: { ...child, metadata: (patch as { metadata: unknown }).metadata } as Session };
      }
      return { data: { ...parent, metadata: (patch as { metadata: unknown }).metadata } as Session };
    });
    const send = vi.fn(async () => undefined);
    const created = await createBtwSession({
      parent: { sessionID: 'parent', directory: 'D:/work', runtimeKey: 'D:/work\nparent' },
      question: 'what', model: { providerID: 'mock', modelID: 'smart' }, store,
      engine: { actions: { fork: vi.fn(async () => 'child'), send,
        deleteSession: vi.fn(async () => undefined) } },
      isCurrent: () => true,
    });
    expect(created.metadata?.openchamber).toEqual({
      kind: 'btw', originalSessionID: 'parent', btwBoundaryMessageID: '',
    });
    expect(send).toHaveBeenCalledOnce();
    expect(updateSession.mock.calls.some((call) => call[0] === 'child' && 'title' in (call[1] as object))).toBe(true);
  });

  it('unlinks and deletes the fork when the first send fails', async () => {
    const parent = session('parent', 'D:/work', { title: 'Main' });
    const child = session('child', 'D:/work', {});
    const store = createDirectoryStore();
    store.setState({ session: [parent], message: { parent: [] } } as never);
    const failedDelete = vi.fn(async () => undefined);
    updateSession.mockImplementation(async (id, patch) => ({
      data: (id === 'parent'
        ? { ...parent, metadata: patch.metadata ?? parent.metadata }
        : { ...child, metadata: patch.metadata ?? child.metadata }) as Session,
    }));
    getSession.mockResolvedValueOnce({ data: child as Session });
    getSession.mockResolvedValueOnce({ data: parent as Session });
    getSession.mockResolvedValueOnce({ data: parent as Session });
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
  });

  it('deletes the fork when post-fork metadata patching fails', async () => {
    const parent = session('parent', 'D:/work', {});
    const child = session('child', 'D:/work', {});
    const store = createDirectoryStore();
    store.setState({ session: [parent], message: { parent: [] } } as never);
    getSession.mockResolvedValueOnce({ data: child as Session });
    updateSession.mockRejectedValueOnce(new Error('metadata failed'));
    const engineDelete = vi.fn(async () => undefined);
    await expect(createBtwSession({
      parent: { sessionID: 'parent', directory: 'D:/work', runtimeKey: 'D:/work\nparent' },
      question: 'what', model: { providerID: 'mock', modelID: 'smart' }, store,
      engine: { actions: {
        fork: vi.fn(async () => 'child'), send: vi.fn(), deleteSession: engineDelete,
      } },
      isCurrent: () => true,
    })).rejects.toThrow('metadata failed');
    expect(engineDelete).toHaveBeenCalledWith('child', 'D:/work');
  });

  it('aborts before metadata when the runtime key changes after fork', async () => {
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
    expect(runtimeDelete).not.toHaveBeenCalled();
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
