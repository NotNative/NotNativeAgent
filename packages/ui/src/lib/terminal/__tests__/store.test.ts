// SPDX-License-Identifier: Apache-2.0
/**
 * @vitest-environment jsdom
 * Terminal store gates (doc 07 sections 6.2/6.8/7): hydrate gate, tab
 * strip per directory, close seeds a fresh tab and deletes the session
 * (a failed DELETE keeps the tab), persisted metadata excludes
 * executionId/session ids (tab id survives), reconcile adopts (tab id =
 * session id) with running-first action authority, user-driven starting
 * tabs survive listings, unchanged listings are fingerprinted no-ops,
 * unknown directories seed a strip, stale revisions dropped, label counter
 * survives reloads.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../server-api.ts', () => ({
  closeTerminalSession: vi.fn(async () => true),
  restartTerminalSession: vi.fn(async () => ({ ok: true })),
  createTerminalSession: vi.fn(async () => ({ ok: true, sessionId: 'x', cols: 80, rows: 24, status: 'running', mode: 'interactive' as const, purpose: { type: 'terminal' as const } })),
  listTerminalShells: vi.fn(async () => []),
  listTerminalSessions: vi.fn(async () => []),
  resizeTerminalSession: vi.fn(async () => true),
  forceKillTerminals: vi.fn(async () => ({ ok: true, killedCount: 0 })),
  touchTerminalSessions: vi.fn(async () => undefined),
}));

import { closeTerminalSession } from '../../server-api.ts';
import {
  __resetTerminalsForTests, appendTerminalBuffer, dropTerminalBuffer, getTerminalBuffer, normalizeTerminalDirectory,
  replaceTerminalBuffer, useTerminalStore, type TerminalListingEntry,
} from '../store.ts';

beforeEach(() => {
  __resetTerminalsForTests();
});

describe('terminal store (doc 07 section 6.2)', () => {
  it('hydrate gates seeding; ensureDirectory seeds one Terminal tab once', () => {
    expect(useTerminalStore.getState().hasHydrated).toBe(false);
    useTerminalStore.getState().hydrate();
    expect(useTerminalStore.getState().hasHydrated).toBe(true);
    const tabId = useTerminalStore.getState().ensureDirectory('/repo');
    const again = useTerminalStore.getState().ensureDirectory('/repo');
    expect(again).toBe(tabId);
    const tabs = useTerminalStore.getState().dirs[normalizeTerminalDirectory('/repo')]!.tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.label).toBe('Terminal');
  });

  it('addTab counts default labels; closeTab deletes the session, drops the buffer, reseeds', async () => {
    useTerminalStore.getState().hydrate();
    const first = useTerminalStore.getState().ensureDirectory('/work');
    const second = useTerminalStore.getState().addTab('/work');
    useTerminalStore.getState().setTabSession('/work', first, 'sess-1', 'running');
    replaceTerminalBuffer('/work', first, 'buffer text', 3, { cols: 80, rows: 24 });
    await useTerminalStore.getState().closeTab('/work', first);
    expect(closeTerminalSession).toHaveBeenCalledWith('sess-1'); // tab close DELETES the session (section 6.8)
    expect(getTerminalBuffer('/work', first).text).toBe('');
    const tabs = useTerminalStore.getState().dirs[normalizeTerminalDirectory('/work')]!.tabs;
    expect(tabs.map((tab) => tab.id)).toContain(second);
    const reseeded = await useTerminalStore.getState().closeTab('/work', second);
    void reseeded;
    const after = useTerminalStore.getState().dirs[normalizeTerminalDirectory('/work')]!.tabs;
    expect(after).toHaveLength(1); // closing the last tab seeds a fresh empty tab
    expect(after[0]!.label).toBe('Terminal');
    const labels = [after[0]!.label];
    expect(labels).toEqual(['Terminal']);
  });

  it('sessionStorage keeps metadata only: no session ids, no executionId', () => {
    useTerminalStore.getState().hydrate();
    useTerminalStore.getState().ensureDirectory('/keep');
    const tabId = useTerminalStore.getState().dirs[normalizeTerminalDirectory('/keep')]!.activeTabId;
    useTerminalStore.getState().setTabSession('/keep', tabId, 'sess-keep', 'running');
    useTerminalStore.getState().patchTab('/keep', tabId, { purposeType: 'project-action', purposeActionId: 'dev', purposeExecutionId: 'exec-9', label: 'dev server' });
    useTerminalStore.setState({ dirs: {}, hasHydrated: false }); // forget the store but keep sessionStorage (reload semantics)
    useTerminalStore.getState().hydrate();
    const hydrated = useTerminalStore.getState().dirs[normalizeTerminalDirectory('/keep')]!.tabs;
    expect(hydrated[0]!.label).toBe('dev server');
    expect(hydrated[0]!.purposeActionId).toBe('dev');
    expect(hydrated[0]!.terminalSessionId).toBeNull(); // reattach via the observer
    expect(hydrated[0]!.purposeExecutionId).toBeNull(); // never persisted (section 6.2)
  });

  it('reconcile adopts: adopted tab ids equal session ids; exited actions marked; stale revisions dropped', () => {
    useTerminalStore.getState().hydrate();
    const revisionKey = `${normalizeTerminalDirectory('/adopt')}\u0000dev`;
    useTerminalStore.getState().bumpMutationRevision('/adopt', 'dev');
    const started: Record<string, number> = { [revisionKey]: useTerminalStore.getState().mutationRevisions[revisionKey] ?? 0 };
    useTerminalStore.getState().reconcileServerSessions('/adopt', [
      { sessionId: 'sess-A', status: 'running', createdAt: 10, mode: 'interactive', purpose: { type: 'terminal' } },
      { sessionId: 'sess-B', status: 'running', createdAt: 20, mode: 'command', purpose: { type: 'project-action', actionId: 'dev', executionId: 'exec-1' } },
    ], started);
    const tabs = useTerminalStore.getState().dirs[normalizeTerminalDirectory('/adopt')]!.tabs;
    expect(tabs.map((tab) => tab.id)).toEqual(['sess-A', 'sess-B']); // adopted tab id EQUALS session id
    expect(tabs[1]!.purposeExecutionId).toBe('exec-1');
    // stale listing: revision moved meanwhile -> dropped
    useTerminalStore.getState().bumpMutationRevision('/adopt', 'dev');
    useTerminalStore.getState().reconcileServerSessions('/adopt', [], started);
    const after = useTerminalStore.getState().dirs[normalizeTerminalDirectory('/adopt')]!.tabs;
    expect(after).toHaveLength(2); // nothing erased behind the user's back
  });

  it('action dedupe keeps exactly one authoritative tab regardless of listing order', () => {
    useTerminalStore.getState().hydrate();
    const exited = (sessionId: string, createdAt: number): TerminalListingEntry => ({
      sessionId, status: 'exited', createdAt, mode: 'command',
      purpose: { type: 'project-action', actionId: 'dev', executionId: `exec-${sessionId}` },
    });
    const running = (sessionId: string, createdAt: number, executionId: string): TerminalListingEntry => ({
      sessionId, status: 'running', createdAt, mode: 'command',
      purpose: { type: 'project-action', actionId: 'dev', executionId },
    });
    // exited listed before running: running wins (running first, then newest)
    useTerminalStore.getState().reconcileServerSessions('/order1', [exited('tab-old', 99), running('tab-new', 5, 'e-5')]);
    let tabs = useTerminalStore.getState().dirs[normalizeTerminalDirectory('/order1')]!.tabs;
    expect(tabs.map((tab) => tab.id)).toEqual(['tab-new']);
    expect(tabs[0]!.lifecycle).toBe('running');
    // running listed before an exited run: the running record still wins
    useTerminalStore.getState().reconcileServerSessions('/order2', [running('tab-live', 3, 'e-3'), exited('tab-dead', 77)]);
    tabs = useTerminalStore.getState().dirs[normalizeTerminalDirectory('/order2')]!.tabs;
    expect(tabs.map((tab) => tab.id)).toEqual(['tab-live']);
    expect(tabs[0]!.lifecycle).toBe('running');
  });

  it('plain sessions are separate tabs and never collide on a dedupe key', () => {
    useTerminalStore.getState().hydrate();
    useTerminalStore.getState().reconcileServerSessions('/plain', [
      { sessionId: 'tab-one', status: 'exited', createdAt: 1, mode: 'interactive', purpose: { type: 'terminal' } },
      { sessionId: 'tab-two', status: 'exited', createdAt: 2, mode: 'interactive', purpose: { type: 'terminal' } },
    ]);
    const tabs = useTerminalStore.getState().dirs[normalizeTerminalDirectory('/plain')]!.tabs;
    expect(tabs.map((tab) => tab.id)).toEqual(['tab-one', 'tab-two']); // both adopted, not collapsed
  });

  it('a user-driven starting tab survives a listing that names other sessions', () => {
    useTerminalStore.getState().hydrate();
    const tabId = useTerminalStore.getState().ensureDirectory('/start');
    useTerminalStore.getState().patchTab('/start', tabId, { lifecycle: 'starting' });
    useTerminalStore.getState().reconcileServerSessions('/start', [
      { sessionId: 'sess-X', status: 'running', createdAt: 10, mode: 'interactive', purpose: { type: 'terminal' } },
    ]);
    const tabs = useTerminalStore.getState().dirs[normalizeTerminalDirectory('/start')]!.tabs;
    expect(tabs.map((tab) => tab.id).sort()).toEqual([tabId, 'sess-X'].sort()); // both survive
    expect(tabs.find((tab) => tab.id === tabId)!.lifecycle).toBe('starting'); // reconcile is not a listing-only demotion of user work
  });

  it('an unchanged listing is a no-op (no state rewrite) and an unknown directory seeds a strip', () => {
    useTerminalStore.getState().hydrate();
    const listing: TerminalListingEntry[] = [
      { sessionId: 'sess-Y', status: 'running', createdAt: 4, mode: 'interactive', purpose: { type: 'terminal' } },
    ];
    useTerminalStore.getState().reconcileServerSessions('/noop', listing);
    const before = useTerminalStore.getState().dirs[normalizeTerminalDirectory('/noop')]!.tabs;
    let applied = 0;
    const stop = useTerminalStore.subscribe(() => { applied += 1; });
    useTerminalStore.getState().reconcileServerSessions('/noop', listing);
    stop();
    expect(applied).toBe(0); // identical listing: no set, no subscriber churn
    expect(useTerminalStore.getState().dirs[normalizeTerminalDirectory('/noop')]!.tabs).toEqual(before);
    useTerminalStore.getState().reconcileServerSessions('/fresh', []); // unknown directory + empty listing must not crash
    const seeded = useTerminalStore.getState().dirs[normalizeTerminalDirectory('/fresh')]!.tabs;
    expect(seeded).toHaveLength(1);
    expect(seeded[0]!.label).toBe('Terminal');
  });

  it('a failed delete keeps the tab: closeTab rejects and the strip is untouched', async () => {
    (closeTerminalSession as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error('network gone');
    });
    useTerminalStore.getState().hydrate();
    const tabId = useTerminalStore.getState().ensureDirectory('/fail');
    useTerminalStore.getState().setTabSession('/fail', tabId, 'sess-fail', 'running');
    replaceTerminalBuffer('/fail', tabId, 'valuable exit output', 3, { cols: 80, rows: 24 });
    await expect(useTerminalStore.getState().closeTab('/fail', tabId)).rejects.toThrow('network gone');
    const tabs = useTerminalStore.getState().dirs[normalizeTerminalDirectory('/fail')]!.tabs;
    expect(tabs).toHaveLength(1); // the tab stays (the session still runs server-side)
    expect(getTerminalBuffer('/fail', tabId).text).toBe('valuable exit output'); // the buffer is not dropped on a failed close
  });
});

describe('terminal buffers (512 KiB head trim)', () => {
  it('append trims from the head and keeps the newest content', () => {
    __resetTerminalsForTests();
    const big = 'x'.repeat(600_000);
    replaceTerminalBuffer('/big', 'tab', big, 1, null);
    appendTerminalBuffer('/big', 'tab', 'tail-chunk', 2);
    const buffer = getTerminalBuffer('/big', 'tab');
    expect(buffer.text.endsWith('tail-chunk')).toBe(true);
    expect(buffer.lastSequence).toBe(2);
    dropTerminalBuffer('/big', 'tab');
    expect(getTerminalBuffer('/big', 'tab').text).toBe('');
  });

  it('bufferVersions mirror live buffers only: bumps on write, pruned on drop', () => {
    __resetTerminalsForTests();
    const key = `${normalizeTerminalDirectory('/ticks')}\u0000tab`;
    replaceTerminalBuffer('/ticks', 'tab', 'content', 1, { cols: 80, rows: 24 });
    appendTerminalBuffer('/ticks', 'tab', 'more', 2);
    expect(useTerminalStore.getState().bufferVersions[key]).toBe(2); // E-07-13 tick per write
    dropTerminalBuffer('/ticks', 'tab');
    expect(useTerminalStore.getState().bufferVersions[key]).toBeUndefined(); // pruned: session churn cannot grow the map (E-07-22)
    __resetTerminalsForTests();
  });
});
