// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { harnessClient } from '../../../lib/nnd/client.ts';
import type { GitStatus } from '../../../lib/git/api.ts';
import { createDirectoryStore } from '../../../sync/child-store.ts';
import { SessionChanges } from '../session-changes.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const directory = '/repo';
const status: GitStatus = { isGitRepository: true, workspacePrefix: '', branch: 'main',
  trackingAhead: 0, trackingBehind: 0, files: [{ path: 'work.ts', index: ' ', working_dir: 'M' }] };

let root: Root | null = null;
let element: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  element?.remove();
  root = null;
  element = null;
  vi.restoreAllMocks();
});

describe('SessionChanges', () => {
  it('starts saved evidence recovery when NNA config arrives after mount', async () => {
    const store = createDirectoryStore();
    const list = vi.spyOn(harnessClient, 'listActivity').mockResolvedValue({ data: [{ id: 'file-1',
      sessionID: 'selected', time: 10, kind: 'tool', status: 'completed', summary: 'Edited work.ts',
      toolEvidence: { reviewPath: 'work.ts', reviewDirectory: directory } }] } as never);
    element = document.createElement('div');
    document.body.appendChild(element);
    root = createRoot(element);
    const onOpen = vi.fn();
    await act(async () => { root!.render(<SessionChanges store={store} directory={directory} sessionID="selected"
      status={status} stale={false} visible onOpen={onOpen} />); });
    expect(list).not.toHaveBeenCalled();
    expect(element.textContent).toContain('No recorded session-touched files');
    await act(async () => { store.getState().patch({ config: { nnd: { engine: 'nna' } } }); });
    expect(list).toHaveBeenCalledWith('selected', { directory });
    expect(element.textContent).toContain('work.ts');
    const file = element.querySelector<HTMLButtonElement>('button[aria-label="View current diff for session-touched work.ts"]');
    expect(file?.disabled).toBe(false);
    await act(async () => { file?.click(); });
    expect(onOpen).toHaveBeenCalledWith('work.ts', false);
  });

  it('does not claim complete evidence when recovery fails and disables stale diffs', async () => {
    const store = createDirectoryStore({ config: { nnd: { engine: 'nna' } }, activity: [{ id: 'file-1',
      sessionID: 'selected', time: 10, kind: 'tool', status: 'completed', summary: 'Edited work.ts',
      toolEvidence: { reviewPath: 'work.ts', reviewDirectory: directory } }] });
    vi.spyOn(harnessClient, 'listActivity').mockRejectedValue(new Error('unavailable'));
    element = document.createElement('div');
    document.body.appendChild(element);
    root = createRoot(element);
    await act(async () => { root!.render(<SessionChanges store={store} directory={directory} sessionID="selected"
      status={status} stale visible onOpen={vi.fn()} />); });
    expect(element.textContent).toContain('Saved activity unavailable; live evidence may be incomplete.');
    expect(element.querySelector<HTMLButtonElement>('button[aria-label="View current diff for session-touched work.ts"]')?.disabled).toBe(true);
  });
});
