// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SavedActivityWindow } from '../saved-activity-window.tsx';
import * as history from '../../sync/durable-activity-history.ts';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
const digest = 'a'.repeat(64);
const snap = { digest, createdAt: 10, durablePresent: true, retainedCount: 2,
  retentionLimit: 500, retainedLowerBound: 'r0', retainedUpperBound: 'r1' };
const row = (id: string) => ({ id, sessionID: 's1', time: 10, kind: 'turn' as const, status: 'completed' as const, summary: id });

function render(sessionID = 's1'): void {
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<SavedActivityWindow directory="D:/work" sessionID={sessionID} />));
}
function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(label));
  if (!found) throw new Error(`missing ${label}`);
  return found;
}
afterEach(() => { act(() => root?.unmount()); container?.remove(); vi.restoreAllMocks(); });

describe('Saved Activity retained window', () => {
  it('pages only inside one snapshot and clears rows on an explicit gap', async () => {
    const read = vi.spyOn(history, 'readDurableActivityPage')
      .mockResolvedValueOnce({ status: 'page', reason: null, snapshot: snap, records: [row('r1')], nextCursor: 'cursor' })
      .mockResolvedValueOnce({ status: 'gap', reason: 'snapshot_changed', snapshot: { ...snap, digest: 'b'.repeat(64) }, records: [], nextCursor: null });
    render();
    await act(async () => { button('Saved Activity').click(); await Promise.resolve(); });
    expect(container.textContent).toContain('partial durable snapshot');
    expect(container.querySelector('[data-testid="saved-activity-rows"]')?.textContent).toContain('r1');
    await act(async () => { button('Load older').click(); await Promise.resolve(); });
    expect(read).toHaveBeenLastCalledWith('s1', 'cursor');
    expect(container.textContent).toContain('snapshot changed');
    expect(container.textContent).not.toContain('r1');
  });

  it('does not publish a delayed response for a different session', async () => {
    let finish!: (page: Awaited<ReturnType<typeof history.readDurableActivityPage>>) => void;
    vi.spyOn(history, 'readDurableActivityPage').mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render();
    await act(async () => { button('Saved Activity').click(); await Promise.resolve(); });
    await act(async () => root.render(<SavedActivityWindow directory="D:/work" sessionID="s2" />));
    await act(async () => finish({ status: 'page', reason: null, snapshot: snap, records: [row('r1')], nextCursor: null }));
    expect(container.textContent).not.toContain('r1');
    expect(container.querySelector('[data-testid="saved-activity-rows"]')).toBeNull();
  });
});
