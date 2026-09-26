// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../lib/files/api.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/files/api.ts')>(), readFileText: vi.fn(),
}));
vi.mock('../../lib/project-context-api.ts', () => ({ importWorkspaceContext: vi.fn(),
  ProjectContextRequestError: class extends Error { constructor(readonly status: number) { super('request failed'); } } }));
import { FileReadError, readFileText } from '../../lib/files/api.ts';
import { importWorkspaceContext, ProjectContextRequestError } from '../../lib/project-context-api.ts';
import { WorkspaceContextImport } from '../workspace-context-import.tsx';

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean | undefined; }
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
const imported = vi.fn();
beforeEach(() => {
  vi.mocked(readFileText).mockReset(); vi.mocked(importWorkspaceContext).mockReset(); imported.mockReset();
  vi.stubGlobal('confirm', vi.fn(() => true));
});
afterEach(() => { act(() => root?.unmount()); container?.remove(); root = null; container = null; vi.unstubAllGlobals(); });
async function render(): Promise<HTMLElement> {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => { root!.render(<WorkspaceContextImport directory="D:/work" projectId="p1" onImported={imported} onClose={() => undefined} />); });
  return container;
}
async function click(label: string): Promise<void> {
  const button = [...container!.querySelectorAll('button')].find((item) => item.textContent === label) as HTMLButtonElement;
  await act(async () => { button.click(); await Promise.resolve(); });
}

it('previews both files before an explicit copy and leaves originals untouched', async () => {
  vi.mocked(readFileText).mockImplementation(async (_, path) => path.endsWith('todos.json')
    ? JSON.stringify([{ id: 'old', text: 'Ship', done: false }]) : 'Original note');
  vi.mocked(importWorkspaceContext).mockResolvedValue({ context: { version: 2, notes: [], todos: [], plans: [] }, importedNotes: 1, importedTodos: 1 });
  const view = await render();
  expect(readFileText).not.toHaveBeenCalled();
  await click('Scan workspace files');
  expect((view.querySelector('[aria-label="Workspace note preview"]') as HTMLTextAreaElement).value).toBe('Original note');
  expect(view.textContent).toContain('Todos: 1');
  expect(importWorkspaceContext).not.toHaveBeenCalled();
  await click('Copy to project context');
  expect(importWorkspaceContext).toHaveBeenCalledWith('p1', { directory: 'D:/work', noteText: 'Original note',
    todos: [{ id: 'old', text: 'Ship', done: false }] });
  expect(imported).toHaveBeenCalledTimes(1);
  expect(view.textContent).toContain('Original files remain unchanged');
});

it('does not submit when either file read is ambiguous or the note exceeds the limit', async () => {
  vi.mocked(readFileText).mockRejectedValue(new FileReadError('denied', 403));
  const view = await render();
  await click('Scan workspace files');
  expect(view.textContent).toContain('Nothing has been copied');
  expect(view.querySelector('[aria-label="Workspace note preview"]')).toBeNull();
  vi.mocked(readFileText).mockImplementation(async (_, path) => path.endsWith('todos.json')
    ? '[]' : 'x'.repeat(3001));
  await click('Scan workspace files');
  expect(([...view.querySelectorAll('button')].find((button) => button.textContent === 'Copy to project context') as HTMLButtonElement).disabled).toBe(true);
  expect(importWorkspaceContext).not.toHaveBeenCalled();
});

it('explains a changed-source conflict instead of suggesting an endless retry', async () => {
  vi.mocked(readFileText).mockImplementation(async (_, path) => path.endsWith('todos.json') ? '[]' : 'Changed note');
  vi.mocked(importWorkspaceContext).mockRejectedValue(new ProjectContextRequestError(409));
  const view = await render();
  await click('Scan workspace files');
  await click('Copy to project context');
  expect(view.textContent).toContain('differs from an earlier copy');
  expect(imported).not.toHaveBeenCalled();
});
