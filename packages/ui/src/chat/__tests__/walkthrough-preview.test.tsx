// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/git/walkthrough-preview.ts', () => ({ loadWalkthroughPreview: vi.fn(), generateWalkthroughPreview: vi.fn() }));
import { generateWalkthroughPreview, loadWalkthroughPreview } from '../../lib/git/walkthrough-preview.ts';
import { WalkthroughPreviewSurface } from '../walkthrough-preview.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const load = loadWalkthroughPreview as ReturnType<typeof vi.fn>;
const generate = generateWalkthroughPreview as ReturnType<typeof vi.fn>;
let container: HTMLDivElement;
let root: Root;
const stop = (path: string) => ({ id: `working:${path}:1:1:0`, scope: 'working', path, header: '@@ -1 +1 @@', oldStart: 1, newStart: 1,
  body: '-old\n+new' });

beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  load.mockReset().mockResolvedValue({ signature: 'rev1', fileCount: 1, stops: [stop('a.ts'), stop('b.ts')] });
  generate.mockReset();
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });

async function render(directory = '/repo'): Promise<void> {
  await act(async () => { root.render(<WalkthroughPreviewSurface directory={directory} sessionId="ses_test" visible />); await Promise.resolve(); });
}

describe('WalkthroughPreviewSurface', () => {
  it('requires no model request and navigates real hunk rows', async () => {
    await render();
    expect(document.body.textContent).toContain('Local Git hunks');
    expect(document.querySelector('[data-testid="walkthrough-hunk"]')?.textContent).toContain('-old');
    act(() => (document.querySelector('button[aria-label="Next hunk"]') as HTMLButtonElement).click());
    expect(document.querySelector('[data-testid="walkthrough-position"]')?.textContent).toBe('2 / 2');
    expect(document.body.textContent).toContain('b.ts');
    expect(load).toHaveBeenCalledTimes(1);
    expect(generate).not.toHaveBeenCalled();
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

  it('generates only on explicit click and shows prose beside its server-owned hunk', async () => {
    generate.mockResolvedValue({ revision: 'rev1', chapters: [{ title: 'Behavior', stops: [
      { id: stop('a.ts').id, explanation: 'The output value changes.' },
    ] }], omittedSensitiveHunks: 1, providerID: 'local', modelID: 'small' });
    await render();
    expect(generate).not.toHaveBeenCalled();
    await act(async () => { (document.querySelector('button:nth-of-type(2)') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(generate).toHaveBeenCalledWith('/repo', 'ses_test', 'rev1', 'all');
    expect(document.body.textContent).toContain('The output value changes.');
    expect(document.body.textContent).toContain('1 sensitive-path hunk(s) were not sent');
    load.mockResolvedValue({ signature: 'rev2', fileCount: 1, stops: [stop('c.ts')] });
    await act(async () => { window.dispatchEvent(new Event('focus')); await Promise.resolve(); });
    expect(document.body.textContent).not.toContain('The output value changes.');
  });

  it('discards a late model result after the selected session changes or the preview refreshes', async () => {
    let finish: ((value: unknown) => void) | undefined;
    generate.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await render();
    await act(async () => { (document.querySelector('button:nth-of-type(2)') as HTMLButtonElement).click(); });
    await act(async () => { root.render(<WalkthroughPreviewSurface directory="/repo" sessionId="ses_other" visible />); });
    await act(async () => { finish?.({ revision: 'rev1', chapters: [{ title: 'Late', stops: [
      { id: stop('a.ts').id, explanation: 'Must not appear.' },
    ] }], omittedSensitiveHunks: 0, providerID: 'local', modelID: 'small' }); });
    expect(document.body.textContent).not.toContain('Must not appear.');
    generate.mockResolvedValue({ revision: 'rev1', chapters: [{ title: 'Current', stops: [
      { id: stop('a.ts').id, explanation: 'Refresh must clear this.' },
    ] }], omittedSensitiveHunks: 0, providerID: 'local', modelID: 'small' });
    await act(async () => { (document.querySelector('button:nth-of-type(2)') as HTMLButtonElement).click(); });
    expect(document.body.textContent).toContain('Refresh must clear this.');
    await act(async () => { (document.querySelector('button:nth-of-type(1)') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(document.body.textContent).not.toContain('Refresh must clear this.');
  });

  it('switches staged and unstaged scopes without carrying the old preview or prose', async () => {
    await render();
    load.mockResolvedValue({ signature: 'rev-staged', fileCount: 1, stops: [stop('staged.ts')] });
    await act(async () => {
      const select = document.querySelector('select[aria-label="Walkthrough scope"]') as HTMLSelectElement;
      select.value = 'staged'; select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(load).toHaveBeenLastCalledWith('/repo', 'staged');
    expect(document.body.textContent).toContain('staged.ts');
    expect(document.body.textContent).not.toContain('b.ts');
  });
});
