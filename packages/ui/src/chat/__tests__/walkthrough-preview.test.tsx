// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/git/walkthrough-preview.ts', () => ({ loadWalkthroughPreview: vi.fn() }));
import { loadWalkthroughPreview } from '../../lib/git/walkthrough-preview.ts';
import { WalkthroughPreviewSurface } from '../walkthrough-preview.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const load = loadWalkthroughPreview as ReturnType<typeof vi.fn>;
let container: HTMLDivElement;
let root: Root;
const stop = (path: string) => ({ id: `working:${path}:1:1:0`, scope: 'working', path, header: '@@ -1 +1 @@', oldStart: 1, newStart: 1,
  hunk: { rows: [{ kind: 'del', text: 'old' }, { kind: 'add', text: 'new' }] } });

beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  load.mockReset().mockResolvedValue({ signature: 'rev1', fileCount: 1, stops: [stop('a.ts'), stop('b.ts')] });
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });

async function render(directory = '/repo'): Promise<void> {
  await act(async () => { root.render(<WalkthroughPreviewSurface directory={directory} visible />); await Promise.resolve(); });
}

describe('WalkthroughPreviewSurface', () => {
  it('requires no model request and navigates real hunk rows', async () => {
    await render();
    expect(document.body.textContent).toContain('Deterministic preview');
    expect(document.querySelector('[data-testid="walkthrough-hunk"]')?.textContent).toContain('-old');
    act(() => (document.querySelector('button[aria-label="Next hunk"]') as HTMLButtonElement).click());
    expect(document.querySelector('[data-testid="walkthrough-position"]')?.textContent).toBe('2 / 2');
    expect(document.body.textContent).toContain('b.ts');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('marks a changed revision stale instead of silently replacing viewed hunks', async () => {
    await render();
    load.mockResolvedValue({ signature: 'rev2', fileCount: 1, stops: [stop('different.ts')] });
    await act(async () => { window.dispatchEvent(new Event('focus')); await Promise.resolve(); });
    expect(document.body.textContent).toContain('Changes moved since this preview was captured');
    expect(document.body.textContent).toContain('a.ts');
    await act(async () => { (document.querySelector('button') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(document.body.textContent).toContain('different.ts');
  });

  it('marks the retained preview unverified when refresh fails', async () => {
    await render();
    load.mockRejectedValue(new Error('Diff exceeds preview limit'));
    await act(async () => { (document.querySelector('button') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(document.body.textContent).toContain('could not be verified against this preview');
    expect(document.body.textContent).toContain('Diff exceeds preview limit');
    expect(document.querySelector('[data-testid="walkthrough-hunk"]')?.textContent).toContain('-old');
  });

  it('does not overlap full Git verification scans on repeated focus events', async () => {
    await render();
    let complete: ((value: { signature: string; fileCount: number; stops: ReturnType<typeof stop>[] }) => void) | undefined;
    load.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    act(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('focus')); });
    expect(load).toHaveBeenCalledTimes(2); // capture plus one verification
    await act(async () => { complete?.({ signature: 'rev1', fileCount: 1, stops: [stop('a.ts')] }); });
  });
});
