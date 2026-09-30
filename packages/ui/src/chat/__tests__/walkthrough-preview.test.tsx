// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/git/walkthrough-preview.ts', () => ({ loadWalkthroughPreview: vi.fn(),
  loadWalkthroughReadiness: vi.fn(),
  generateWalkthroughPreview: vi.fn(), fetchWalkthroughStage: vi.fn(), cancelWalkthroughStage: vi.fn() }));
import { cancelWalkthroughStage, fetchWalkthroughStage, loadWalkthroughReadiness } from '../../lib/git/walkthrough-preview.ts';
import { generateWalkthroughPreview, loadWalkthroughPreview } from '../../lib/git/walkthrough-preview.ts';
import { WalkthroughPreviewSurface } from '../walkthrough-preview.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const load = loadWalkthroughPreview as ReturnType<typeof vi.fn>;
const readiness = loadWalkthroughReadiness as ReturnType<typeof vi.fn>;
const generate = generateWalkthroughPreview as ReturnType<typeof vi.fn>;
const stageFetch = fetchWalkthroughStage as ReturnType<typeof vi.fn>;
const stageCancel = cancelWalkthroughStage as ReturnType<typeof vi.fn>;
let container: HTMLDivElement;
let root: Root;
const stop = (path: string) => ({ id: `working:${path}:1:1:0`, scope: 'working', path, header: '@@ -1 +1 @@', oldStart: 1, newStart: 1,
  body: '-old\n+new' });

beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  load.mockReset().mockResolvedValue({ signature: 'rev1', fileCount: 1, stops: [stop('a.ts'), stop('b.ts')] });
  readiness.mockReset();
  readiness.mockResolvedValue({
    model: null,
    options: [],
    readiness: { ready: true, reason: null, requiredChars: 1000, availableChars: null },
  });
  generate.mockReset();
  stageFetch.mockReset();
  stageCancel.mockReset();
  stageFetch.mockResolvedValue(null);
  stageCancel.mockResolvedValue(true);
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

  it('loads readiness independently from preview and shows a bounded blocker', async () => {
    readiness.mockResolvedValue({
      model: { providerID: 'local', modelID: 'compact', label: 'Compact (compact)', hasLogin: true,
        structuredOutput: true, inputCharBudget: 100, contextTokens: 200, contextKnown: true, outputTokens: 50 },
      options: [
        { providerID: 'local', modelID: 'compact', label: 'Compact (compact)', hasLogin: true,
          structuredOutput: true, inputCharBudget: 100, contextTokens: 200, contextKnown: true, outputTokens: 50 },
        { providerID: 'local', modelID: 'small', label: 'Small (small)', hasLogin: true,
          structuredOutput: true, inputCharBudget: 100, contextTokens: 200, contextKnown: true, outputTokens: 50 },
      ],
      readiness: { ready: false, reason: 'context-too-small', requiredChars: 120, availableChars: 100 },
    });
    await render();
    expect(document.body.textContent).toContain('Diff needs 120 chars');
    expect(document.querySelector('select[aria-label="Walkthrough model"]')?.textContent).toContain('Small (small)');
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
    expect(document.body.textContent).toContain('The output value changes.');
    expect(document.body.textContent).toContain('1 sensitive-path hunk(s) were not sent');
    expect(generate).toHaveBeenCalledWith('/repo', 'ses_test', 'rev1', 'all', 'en', '');
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

  it('separates pull-request sources that differ by repository', async () => {
    await render();
    const select = document.querySelector('select[aria-label="Walkthrough scope"]') as HTMLSelectElement;
    await act(async () => {
      select.value = 'pr'; select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    const setValue = (input: HTMLInputElement, value: string): void => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const setNumber = (value: string): void => {
      const input = document.querySelector<HTMLInputElement>('input[aria-label="Pull request number"]');
      if (input) setValue(input, value);
    };
    const setRepo = (label: string, value: string): void => {
      const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
      if (input) setValue(input, value);
    };
    await act(async () => {
      setNumber('1'); setRepo('PR owner', 'owner'); setRepo('PR repository', 'desktop');
      await Promise.resolve();
    });
    load.mockReset().mockImplementation(async (directory, selected) => (
      selected.kind === 'pr' && selected.sourceRepo?.repo === 'desktop'
        ? { signature: 'repo-rev', fileCount: 1, stops: [stop('fork.ts')] }
        : { signature: 'rev1', fileCount: 1, stops: [stop('a.ts'), stop('b.ts')] }
    ));
    await act(async () => { setNumber('1'); setRepo('PR owner', 'owner'); setRepo('PR repository', 'desktop'); await Promise.resolve(); });
    await act(async () => { (document.querySelector('header button') as HTMLButtonElement).click(); await Promise.resolve(); await Promise.resolve(); });
    expect(load).toHaveBeenLastCalledWith('/repo', { kind: 'pr', number: 1, sourceRepo: { owner: 'owner', repo: 'desktop' } });
    expect(document.body.textContent).toContain('fork.ts');
  });

  it('stops the progress watcher when the walkthrough pane unmounts', async () => {
    let provide: ((value: string | null) => void) | undefined;
    stageFetch.mockImplementation(() => new Promise<string | null>((resolve) => { provide = resolve; }));
    generate.mockImplementation(() => new Promise(() => {}));
    await render();
    await act(async () => { (document.querySelector('button:nth-of-type(2)') as HTMLButtonElement).click(); await Promise.resolve(); });
    const firstObservers = stageFetch.mock.calls.length;
    act(() => root.unmount());
    container.remove();
    await act(async () => { provide?.('asking'); await Promise.resolve(); await Promise.resolve(); });
    expect(stageFetch.mock.calls.length).toBe(firstObservers);
  });

  it('shows lifecycle progress and detaches before cancelling the server job', async () => {
    stageFetch.mockResolvedValue('asking');
    let finish: ((value: unknown) => void) | undefined;
    generate.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await render();
    await act(async () => { (document.querySelector('button:nth-of-type(2)') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(stageFetch).toHaveBeenCalledWith('/repo', 'all', expect.any(AbortSignal), null);
    expect(document.body.textContent).toContain('Walkthrough stage: asking');

    await act(async () => { (document.querySelector('button:nth-of-type(3)') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(stageCancel).toHaveBeenCalledWith('/repo', 'all', null);
    expect(document.body.textContent).toContain('Walkthrough generation cancelled.');
    expect(document.body.textContent).not.toContain('Walkthrough stage: asking');
    await act(async () => { finish?.({ revision: 'rev1', chapters: [], omittedSensitiveHunks: 0, providerID: 'local', modelID: 'small' }); });
    expect(document.body.textContent).not.toContain('The output value changes.');
  });

  it('stops detached lifecycle polling without leaking a server job across reconnects', async () => {
    stageFetch.mockResolvedValue('collecting');
    let finished = false;
    let finish: ((value: unknown) => void) | undefined;
    generate.mockImplementation(async () => new Promise((resolve) => { finish = resolve; }));
    await render();
    await act(async () => { (document.querySelector('button:nth-of-type(2)') as HTMLButtonElement).click(); await Promise.resolve(); });
    const pollsAfterStart = stageFetch.mock.calls.length;
    await act(async () => { (document.querySelector('button:nth-of-type(1)') as HTMLButtonElement).click(); await Promise.resolve(); });
    vi.useFakeTimers();
    await act(async () => {
      vi.advanceTimersByTime(450);
      await Promise.resolve();
    });
    expect(stageFetch.mock.calls.length).toBe(pollsAfterStart);
    vi.useRealTimers();
    finished = true;
    await act(async () => { finish?.({
      revision: 'rev1', chapters: [], omittedSensitiveHunks: 0, providerID: 'local', modelID: 'small',
    }); });
    expect(stageCancel).not.toHaveBeenCalled();
    expect(finished).toBe(true);
  });
});
