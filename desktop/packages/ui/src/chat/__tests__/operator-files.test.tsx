// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../components/files/FileTree.tsx', () => ({
  FileTree: ({ onOpenFile, visible, readOnly }: { onOpenFile: (path: string) => void; visible: boolean; readOnly: boolean }) =>
    <div data-testid="mock-tree" data-visible={visible} data-read-only={readOnly}>
      <button onClick={() => onOpenFile('/repo/one.ts')}>one.ts</button>
      <button onClick={() => onOpenFile('/repo/two.ts')}>two.ts</button>
      <button onClick={() => onOpenFile('/repo/photo.png')}>photo.png</button>
    </div>,
}));
vi.mock('../../lib/files/api.ts', () => ({ readFileStat: vi.fn(), readFileText: vi.fn() }));

import { readFileStat, readFileText } from '../../lib/files/api.ts';
import { OperatorFiles } from '../operator-files.tsx';
import { FILES_OPEN_EVENT } from '../../components/scheduled/scheduled-tasks-dialog.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const stat = vi.mocked(readFileStat);
const read = vi.mocked(readFileText);
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  stat.mockResolvedValue({ path: '/repo/one.ts', isFile: true, size: 20, mtimeMs: 1 });
  read.mockResolvedValue('line one\nline two');
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function render(visible = true): Promise<void> {
  await act(async () => { root.render(<OperatorFiles directory="/repo" visible={visible} />); await Promise.resolve(); });
}
async function select(label: string): Promise<void> {
  await act(async () => { ([...container.querySelectorAll('button')].find((button) => button.textContent === label) as HTMLButtonElement).click(); await Promise.resolve(); });
}

describe('operator Files preview', () => {
  it('previews text without exposing mutations and hands the selected file to the full editor', async () => {
    await render();
    expect(container.querySelector('[data-testid="mock-tree"]')?.getAttribute('data-read-only')).toBe('true');
    await select('one.ts');
    expect(container.querySelector('[data-testid="operator-file-preview"]')?.textContent).toContain('line one');
    expect(read).toHaveBeenCalledWith('/repo', '/repo/one.ts', true);
    const handoff = vi.fn();
    window.addEventListener(FILES_OPEN_EVENT, handoff, { once: true });
    await select('Open editor');
    expect((handoff.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ directory: '/repo', path: '/repo/one.ts' });
    await render(false);
    expect(container.querySelector('[data-testid="mock-tree"]')?.getAttribute('data-visible')).toBe('false');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('does not fetch known binary files or oversized text into the side preview', async () => {
    await render();
    await select('photo.png');
    expect(container.textContent).toContain('Binary or media file');
    expect(read).not.toHaveBeenCalled();
    stat.mockResolvedValue({ path: '/repo/two.ts', isFile: true, size: 600_000, mtimeMs: 1 });
    await select('two.ts');
    expect(container.textContent).toContain('too large');
    expect(read).not.toHaveBeenCalled();
  });

  it('discards an older file response after a newer selection', async () => {
    let release!: (text: string) => void;
    read.mockImplementation((_directory, path) => path.endsWith('one.ts')
      ? new Promise<string>((resolve) => { release = resolve; }) : Promise.resolve('new file'));
    await render();
    await select('one.ts');
    await select('two.ts');
    expect(container.textContent).toContain('new file');
    await act(async () => { release('old file'); await Promise.resolve(); });
    expect(container.textContent).not.toContain('old file');
  });
});
