// SPDX-License-Identifier: Apache-2.0
/**
 * SLICE-A chat-alive boot-open (doc 05 §A boot-open, v1): the priority rules
 * for which session opens at boot (existing selection > persisted last-active
 * pointer validated against the authoritative list and this directory > the
 * non-archived seeded welcome demo > nothing), by openInitialSession.
 */
import { describe, expect, it } from 'vitest';

import { openInitialSession, type InitialOpenInput } from '../engine-instance.ts';
import { normalizeDirectory } from '../../lib/nnd/client.ts';
import type { Session } from '../../lib/nnd/types.ts';

const DIRECTORY = 'D:\\work';
const directoryKey = normalizeDirectory(DIRECTORY);

function sessionOf(id: string, title: string, archived?: number): Session {
  return {
    id,
    slug: id,
    projectID: 'proj',
    directory: DIRECTORY,
    title,
    version: '2026.0.0',
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1_000, updated: 2_000, ...(archived ? { archived } : {}) },
    ...({} as Record<string, never>),
  } as Session;
}

interface Selection { sessionID: string; directory: string }

function inputOf(overrides: Partial<InitialOpenInput> = {}): { input: InitialOpenInput; calls: Selection[] } {
  const calls: Selection[] = [];
  const input: InitialOpenInput = {
    currentSessionId: null,
    directory: directoryKey,
    storeSessions: [sessionOf('ses_welcome', 'Welcome to NotNativeDesktop')],
    pointer: null,
    select: (sessionID, directory) => { calls.push({ sessionID, directory }); },
    ...overrides,
  };
  return { input, calls };
}

describe('boot-open', () => {
  it('is a no-op when a selection already exists (user or draft wins)', async () => {
    const { input, calls } = inputOf({ currentSessionId: 'ses_live', pointer: { sessionId: 'ses_welcome', directory: directoryKey } });
    await openInitialSession(input);
    expect(calls).toEqual([]);
  });

  it('opens the persisted pointer when it still exists in this directory', async () => {
    const { input, calls } = inputOf({
      storeSessions: [sessionOf('ses_welcome', 'Welcome to NotNativeDesktop'), sessionOf('ses_prev', 'Real work')],
      pointer: { sessionId: 'ses_prev', directory: directoryKey },
    });
    await openInitialSession(input);
    expect(calls).toEqual([{ sessionID: 'ses_prev', directory: directoryKey }]);
  });

  it('reopens a governed session in its current workspace after the saved directory becomes stale', async () => {
    const moved = { ...sessionOf('ses_moved', 'Moved work'), directory: 'D:/next' };
    const { input, calls } = inputOf({
      storeSessions: [moved],
      pointer: { sessionId: 'ses_moved', directory: directoryKey },
    });
    await openInitialSession(input);
    expect(calls).toEqual([{ sessionID: 'ses_moved', directory: 'D:/next' }]);
  });

  it('reopens a pointer that matches its authoritative session in another workspace', async () => {
    const other = { ...sessionOf('ses_other', 'Other work'), directory: 'D:/elsewhere' };
    const { input, calls } = inputOf({
      storeSessions: [other],
      pointer: { sessionId: 'ses_other', directory: 'D:/elsewhere' },
    });
    await openInitialSession(input);
    expect(calls).toEqual([{ sessionID: 'ses_other', directory: 'D:/elsewhere' }]);
  });

  it('falls back to the welcome seed when the pointer session vanished (crash/archive)', async () => {
    const { input, calls } = inputOf({ pointer: { sessionId: 'ses_gone', directory: directoryKey } });
    await openInitialSession(input);
    expect(calls).toEqual([{ sessionID: 'ses_welcome', directory: directoryKey }]);
  });

  it('ignores a pointer from a DIFFERENT directory (wrong workspace)', async () => {
    const { input, calls } = inputOf({
      storeSessions: [sessionOf('ses_other', 'other-workspace-session')],
      pointer: { sessionId: 'ses_other', directory: 'D:/elsewhere' },
    });
    await openInitialSession(input);
    expect(calls).toEqual([]);
  });

  it('falls back to the seeded welcome demo on first run', async () => {
    const { input, calls } = inputOf({});
    await openInitialSession(input);
    expect(calls).toEqual([{ sessionID: 'ses_welcome', directory: directoryKey }]);
  });

  it('never opens an ARCHIVED welcome demo; nothing opens instead', async () => {
    const { input, calls } = inputOf({ storeSessions: [sessionOf('ses_welcome', 'Welcome to NotNativeDesktop', 42)] });
    await openInitialSession(input);
    expect(calls).toEqual([]);
  });

  it('does not route a welcome session from another workspace into this one', async () => {
    const other = { ...sessionOf('ses_welcome', 'Welcome to NotNativeDesktop'), directory: 'D:/elsewhere' };
    const { input, calls } = inputOf({ storeSessions: [other] });
    await openInitialSession(input);
    expect(calls).toEqual([]);
  });

  it('does not treat an arbitrary welcome-prefixed child as the seeded demo', async () => {
    const child = { ...sessionOf('ses_child', 'Welcome to my plan'), parentID: 'ses_parent' };
    const { input, calls } = inputOf({ storeSessions: [child] });
    await openInitialSession(input);
    expect(calls).toEqual([]);
  });

  it('opens nothing when there is no pointer and no welcome seed', async () => {
    const { input, calls } = inputOf({ storeSessions: [sessionOf('ses_1', 'nna-made session')] });
    await openInitialSession(input);
    expect(calls).toEqual([]);
  });
});
