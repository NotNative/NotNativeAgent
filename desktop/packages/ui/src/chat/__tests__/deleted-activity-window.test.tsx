// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
const runtime = vi.hoisted(() => ({ key: 'owner-runtime', listeners: new Set<() => void>() }));
vi.mock('../../lib/runtime-switch.ts', () => ({
  getRuntimeKey: () => runtime.key,
  onRuntimeEndpointChanged: (listener: () => void) => { runtime.listeners.add(listener);
    return () => runtime.listeners.delete(listener); },
}));
import { DeletedActivityWindow } from '../deleted-activity-window.tsx';
import * as tombstones from '../../sync/activity-tombstones.ts';
import { useAuthSessionStore } from '../../lib/runtime-auth-expiry.ts';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
function render(): void {
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<DeletedActivityWindow />));
}
function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(label));
  if (!found) throw new Error(`missing ${label}`);
  return found;
}
afterEach(() => { act(() => root?.unmount()); container?.remove(); vi.restoreAllMocks();
  useAuthSessionStore.getState().markOk(); });

describe('retained deletion receipts', () => {
  it('clears accumulated rows when the retention floor moves during paging', async () => {
    const rows = Array.from({ length: 50 }, (_, index) => ({ sequence: index + 1, sessionID: `old-${index + 1}`,
      createdAt: 10, deletedAt: 20, kind: 'deleted' as const }));
    vi.spyOn(tombstones, 'readDeletionPage')
      .mockResolvedValueOnce({ status: 'page', floor: 0, nextCursor: 50, records: rows, historyComplete: false })
      .mockResolvedValueOnce({ status: 'page', floor: 1, nextCursor: 51, records: [{ sequence: 51,
        sessionID: 'new-51', createdAt: 10, deletedAt: 20, kind: 'deleted' }], historyComplete: false });
    render();
    await act(async () => { button('Deleted sessions').click(); await Promise.resolve(); });
    expect(container.textContent).toContain('old-1');
    await act(async () => { button('Load later retained receipts').click(); await Promise.resolve(); });
    expect(container.textContent).toContain('retained deletion window moved');
    expect(container.textContent).not.toContain('old-1');
    expect(container.textContent).not.toContain('new-51');
  });

  it('hides previous-owner receipts through same-runtime reauthentication', async () => {
    vi.spyOn(tombstones, 'readDeletionPage').mockResolvedValueOnce({ status: 'page', floor: 0, nextCursor: 1,
      records: [{ sequence: 1, sessionID: 'owner-one', createdAt: 10, deletedAt: 20, kind: 'deleted' }],
      historyComplete: false });
    render();
    await act(async () => { button('Deleted sessions').click(); await Promise.resolve(); });
    expect(container.textContent).toContain('owner-one');
    await act(async () => { useAuthSessionStore.getState().beginReauthentication(); });
    expect(container.textContent).not.toContain('owner-one');
    await act(async () => { useAuthSessionStore.getState().markOk(); });
    expect(container.textContent).not.toContain('owner-one');
  });

  it('drops old-owner rows and late replies after a same-key endpoint credential switch', async () => {
    let resolve!: (page: tombstones.DeletionPage) => void;
    vi.spyOn(tombstones, 'readDeletionPage').mockImplementationOnce(() => new Promise(done => { resolve = done; }))
      .mockResolvedValueOnce({ status: 'page', floor: 0, nextCursor: 1, records: [{ sequence: 1,
        sessionID: 'owner-two', createdAt: 10, deletedAt: 20, kind: 'deleted' }], historyComplete: false });
    render();
    await act(async () => { button('Deleted sessions').click(); });
    await act(async () => { for (const listener of runtime.listeners) listener(); });
    await act(async () => { resolve({ status: 'page', floor: 0, nextCursor: 1, records: [{ sequence: 1,
      sessionID: 'owner-one', createdAt: 10, deletedAt: 20, kind: 'deleted' }], historyComplete: false });
      await Promise.resolve(); });
    expect(container.textContent).not.toContain('owner-one');
    await act(async () => { button('Deleted sessions').click(); await Promise.resolve(); });
    expect(container.textContent).toContain('owner-two');
  });

  it('clears a retention gap before loading the new floor and never claims complete history', async () => {
    const read = vi.spyOn(tombstones, 'readDeletionPage')
      .mockResolvedValueOnce({ status: 'gap', floor: 3, nextCursor: null, records: [], historyComplete: false })
      .mockResolvedValueOnce({ status: 'page', floor: 3, nextCursor: 4, records: [{ sequence: 4,
        sessionID: 'removed-session', createdAt: 10, deletedAt: 20, kind: 'deleted' }], historyComplete: false });
    render();
    await act(async () => { button('Deleted sessions').click(); await Promise.resolve(); });
    expect(container.textContent).toContain('not a complete deletion history');
    expect(container.textContent).toContain('retained deletion window moved');
    await act(async () => { button('Load retained receipts').click(); await Promise.resolve(); });
    expect(read).toHaveBeenLastCalledWith(3);
    expect(container.querySelector('[data-testid="deleted-activity-rows"]')?.textContent).toContain('removed-session');
  });
});
