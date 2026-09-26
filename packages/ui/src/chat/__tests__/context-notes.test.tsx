// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../lib/project-context-api.ts', () => ({
  getProjectContext: vi.fn(), createProjectNote: vi.fn(), updateProjectNote: vi.fn(), deleteProjectNote: vi.fn(),
}));
import { createProjectNote, deleteProjectNote, getProjectContext, updateProjectNote } from '../../lib/project-context-api.ts';
import { ContextNotes } from '../context-notes.tsx';

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean | undefined; }
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
const empty = { version: 2 as const, notes: [], todos: [], plans: [] };

beforeEach(() => {
  vi.mocked(getProjectContext).mockReset().mockResolvedValue(empty);
  vi.mocked(createProjectNote).mockReset();
  vi.mocked(updateProjectNote).mockReset();
  vi.mocked(deleteProjectNote).mockReset();
});
afterEach(() => { act(() => root?.unmount()); container?.remove(); root = null; container = null; });

async function render(): Promise<HTMLElement> {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => { root!.render(<ContextNotes projectId="p1" visible />); await Promise.resolve(); });
  return container;
}

function typeInto(label: string, value: string): void {
  const area = container!.querySelector(`textarea[aria-label="${label}"]`) as HTMLTextAreaElement;
  act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, value);
    area.dispatchEvent(new Event('input', { bubbles: true })); });
}

async function click(label: string): Promise<void> {
  const button = [...container!.querySelectorAll('button')].find((item) => item.textContent === label)!;
  await act(async () => { button.click(); await Promise.resolve(); });
}

describe('NND-owned context notes panel', () => {
  it('filters visible notes without changing the stored list or a draft', async () => {
    const first = { id: 'n1', body: 'Alpha note', createdAt: 1, updatedAt: 1, source: 'manual' as const };
    const second = { ...first, id: 'n2', body: 'Beta note' };
    vi.mocked(getProjectContext).mockResolvedValue({ ...empty, notes: [first, second] });
    const view = await render();
    typeInto('New context note', 'Draft remains');
    await act(async () => { root!.render(<ContextNotes projectId="p1" visible query="alpha" />); });
    expect(view.textContent).toContain('Alpha note');
    expect(view.textContent).not.toContain('Beta note');
    expect((view.querySelector('[aria-label="New context note"]') as HTMLTextAreaElement).value).toBe('Draft remains');
    await act(async () => { root!.render(<ContextNotes projectId="p1" visible query="" />); });
    expect(view.textContent).toContain('Beta note');
    expect(getProjectContext).toHaveBeenCalledTimes(1);
  });
  it('settles a failed initial load and lets the operator retry', async () => {
    vi.mocked(getProjectContext).mockRejectedValueOnce(new Error('offline'));
    const view = await render();
    expect(view.textContent).toContain('Context could not be loaded');
    expect(view.textContent).not.toContain('Loading project context');
    await click('Refresh');
    expect(view.querySelector('textarea[aria-label="New context note"]')).not.toBeNull();
  });

  it('does not let an older refresh response replace a committed create', async () => {
    const view = await render();
    let resolveRefresh!: (value: typeof empty) => void;
    vi.mocked(getProjectContext).mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));
    await click('Refresh');
    const note = { id: 'n1', body: 'Committed', createdAt: 1, updatedAt: 1, source: 'manual' as const };
    vi.mocked(createProjectNote).mockResolvedValue({ note, context: { ...empty, notes: [note] } });
    typeInto('New context note', 'Committed');
    await click('Add note');
    await act(async () => { resolveRefresh(empty); await Promise.resolve(); });
    expect(view.textContent).toContain('Committed');
  });

  it('warns when stored note rows cannot be displayed', async () => {
    vi.mocked(getProjectContext).mockResolvedValue({ ...empty, notes: [null] } as never);
    const view = await render();
    expect(view.textContent).toContain('Some stored notes could not be displayed');
  });

  it('adopts committed create, edit, and delete responses without writing legacy repo files', async () => {
    const view = await render();
    const note = { id: 'n1', body: 'New', createdAt: 1, updatedAt: 1, source: 'manual' as const };
    vi.mocked(createProjectNote).mockResolvedValue({ note, context: { ...empty, notes: [note] } });
    typeInto('New context note', 'New'); await click('Add note');
    expect(createProjectNote).toHaveBeenCalledWith('p1', { body: 'New' });
    expect(view.textContent).toContain('New');
    await click('Edit');
    typeInto('Edit context note', 'Changed');
    vi.mocked(updateProjectNote).mockResolvedValue({ ...note, body: 'Changed' });
    await click('Save edit');
    expect(updateProjectNote).toHaveBeenCalledWith('p1', 'n1', { body: 'Changed' });
    expect(view.textContent).toContain('Changed');
    vi.mocked(deleteProjectNote).mockResolvedValue(empty);
    await click('Delete');
    expect(deleteProjectNote).toHaveBeenCalledWith('p1', 'n1');
    expect(view.textContent).not.toContain('Changed');
  });

  it('keeps the draft and previous context on failed load or create', async () => {
    const view = await render();
    typeInto('New context note', 'Keep draft');
    vi.mocked(createProjectNote).mockRejectedValue(new Error('offline'));
    await click('Add note');
    expect((view.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Keep draft');
    expect(view.textContent).toContain('Note could not be saved');
    vi.mocked(getProjectContext).mockRejectedValue(new Error('offline'));
    await click('Refresh');
    expect(view.querySelector('textarea')).not.toBeNull();
    expect(view.textContent).toContain('Existing notes were left untouched');
  });
});
