// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../lib/project-context-api.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/project-context-api.ts')>(),
  getProjectContext: vi.fn(), replaceProjectTodos: vi.fn(),
}));
import { getProjectContext, ProjectContextRequestError, replaceProjectTodos } from '../../lib/project-context-api.ts';
import { ContextTodos } from '../context-todos.tsx';

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean | undefined; }
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
const revision = 'a'.repeat(64);
const empty = { version: 2 as const, notes: [], todos: [], plans: [], todosRevision: revision };
beforeEach(() => {
  vi.mocked(getProjectContext).mockReset().mockResolvedValue(empty);
  vi.mocked(replaceProjectTodos).mockReset();
  vi.stubGlobal('crypto', { randomUUID: () => 'todo-1' });
});
afterEach(() => { act(() => root?.unmount()); container?.remove(); root = null; container = null; vi.unstubAllGlobals(); });
async function render(projectId = 'project1'): Promise<HTMLElement> {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => { root!.render(<ContextTodos projectId={projectId} visible />); await Promise.resolve(); });
  return container;
}
function typeTodo(value: string): void {
  const field = container!.querySelector('[aria-label="New project todo"]') as HTMLInputElement;
  act(() => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function click(label: string): Promise<void> {
  const button = [...container!.querySelectorAll('button')].find((item) => item.textContent === label)!;
  await act(async () => { button.click(); await Promise.resolve(); });
}

describe('project context todos panel', () => {
  it('filters displayed todos but commits against the complete list', async () => {
    const first = { id: 'one', text: 'Alpha task', completed: false, createdAt: 1 };
    const second = { id: 'two', text: 'Beta task', completed: false, createdAt: 2 };
    vi.mocked(getProjectContext).mockResolvedValue({ ...empty, todos: [first, second] });
    const view = await render();
    await act(async () => { root!.render(<ContextTodos projectId="project1" visible query="alpha" />); });
    expect(view.textContent).toContain('Alpha task');
    expect(view.textContent).not.toContain('Beta task');
    vi.mocked(replaceProjectTodos).mockResolvedValue({ ...empty, todos: [{ ...first, completed: true }, second] });
    await act(async () => { (view.querySelector('[aria-label="Complete Alpha task"]') as HTMLInputElement).click(); await Promise.resolve(); });
    expect(replaceProjectTodos).toHaveBeenCalledWith('project1', [{ ...first, completed: true }, second], revision);
  });
  it('adds and adopts committed server truth, then toggles and deletes', async () => {
    const view = await render();
    typeTodo('Ship MVP');
    const item = { id: 'todo-1', text: 'Ship MVP', completed: false, createdAt: 1 };
    vi.mocked(replaceProjectTodos).mockResolvedValueOnce({ ...empty, todos: [item] });
    await click('Add todo');
    expect(replaceProjectTodos).toHaveBeenCalledWith('project1', [expect.objectContaining({ id: item.id, text: item.text })], revision);
    expect(view.textContent).toContain('Ship MVP');
    vi.mocked(replaceProjectTodos).mockResolvedValueOnce({ ...empty, todos: [{ ...item, completed: true }] });
    await act(async () => { (view.querySelector('[aria-label="Complete Ship MVP"]') as HTMLInputElement).click(); await Promise.resolve(); });
    expect(replaceProjectTodos).toHaveBeenLastCalledWith('project1', [{ ...item, completed: true }], revision);
    vi.mocked(replaceProjectTodos).mockResolvedValueOnce(empty);
    await click('Delete');
    expect(view.textContent).not.toContain('Ship MVP');
  });

  it('preserves the last committed list and draft on failure', async () => {
    const view = await render(); typeTodo('Keep draft');
    vi.mocked(replaceProjectTodos).mockRejectedValue(new Error('offline'));
    await click('Add todo');
    expect((view.querySelector('[aria-label="New project todo"]') as HTMLInputElement).value).toBe('Keep draft');
    expect(view.textContent).toContain('last saved list remain');
  });

  it('blocks further edits after a stale-write conflict until refresh adopts current truth', async () => {
    const view = await render(); typeTodo('Keep draft');
    vi.mocked(replaceProjectTodos).mockRejectedValueOnce(new ProjectContextRequestError(409));
    await click('Add todo');
    expect(view.textContent).toContain('changed in another window');
    expect((view.querySelector('[aria-label="New project todo"]') as HTMLInputElement).disabled).toBe(true);
    expect((view.querySelector('[aria-label="New project todo"]') as HTMLInputElement).value).toBe('Keep draft');
    vi.mocked(getProjectContext).mockResolvedValueOnce({ ...empty, todosRevision: 'b'.repeat(64) });
    await click('Refresh');
    expect((view.querySelector('[aria-label="New project todo"]') as HTMLInputElement).disabled).toBe(false);
    vi.mocked(replaceProjectTodos).mockResolvedValueOnce({ ...empty, todosRevision: 'c'.repeat(64),
      todos: [{ id: 'todo-1', text: 'Keep draft', completed: false, createdAt: 1 }] });
    await click('Add todo');
    expect(replaceProjectTodos).toHaveBeenLastCalledWith('project1', [expect.objectContaining({ text: 'Keep draft' })], 'b'.repeat(64));
  });

  it('refuses to overwrite malformed stored entries', async () => {
    vi.mocked(getProjectContext).mockResolvedValue({ ...empty, todos: [{ id: 'legacy', text: 'old' }] });
    const view = await render();
    expect(view.textContent).toContain('Editing is disabled');
    expect((view.querySelector('[aria-label="New project todo"]') as HTMLInputElement).disabled).toBe(true);
    expect(replaceProjectTodos).not.toHaveBeenCalled();
  });

  it('does not let a pre-commit refresh overwrite the committed list', async () => {
    const view = await render();
    typeTodo('Keep committed');
    let finishWrite!: (value: typeof empty) => void;
    vi.mocked(replaceProjectTodos).mockImplementationOnce(() => new Promise((resolve) => { finishWrite = resolve; }));
    await click('Add todo');
    let finishRead!: (value: typeof empty) => void;
    vi.mocked(getProjectContext).mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    await act(async () => { root!.render(<ContextTodos projectId="project1" visible={false} />); });
    await act(async () => { root!.render(<ContextTodos projectId="project1" visible />); });
    expect(finishRead).toBeTypeOf('function');
    await act(async () => { finishWrite({ ...empty, todos: [{ id: 'todo-1', text: 'Keep committed',
      completed: false, createdAt: 1 }] } as typeof empty); await Promise.resolve(); });
    await act(async () => { finishRead(empty); await Promise.resolve(); });
    expect(view.textContent).toContain('Keep committed');
    expect((view.querySelector('[aria-label="New project todo"]') as HTMLInputElement).disabled).toBe(false);
  });

  it('clears a failed refresh error when an in-flight write commits', async () => {
    const view = await render();
    typeTodo('Keep committed');
    let finishWrite!: (value: typeof empty) => void;
    vi.mocked(replaceProjectTodos).mockImplementationOnce(() => new Promise((resolve) => { finishWrite = resolve; }));
    await click('Add todo');
    let failRead!: (reason: Error) => void;
    vi.mocked(getProjectContext).mockImplementationOnce(() => new Promise((_resolve, reject) => { failRead = reject; }));
    await act(async () => { root!.render(<ContextTodos projectId="project1" visible={false} />); });
    await act(async () => { root!.render(<ContextTodos projectId="project1" visible />); });
    await act(async () => { failRead(new Error('offline')); await Promise.resolve(); });
    expect(view.textContent).toContain('could not be loaded');
    await act(async () => { finishWrite({ ...empty, todos: [{ id: 'todo-1', text: 'Keep committed',
      completed: false, createdAt: 1 }] } as typeof empty); await Promise.resolve(); });
    expect(view.textContent).toContain('Keep committed');
    expect(view.textContent).not.toContain('could not be loaded');
    expect((view.querySelector('[aria-label="New project todo"]') as HTMLInputElement).disabled).toBe(false);
  });

  it('disables editing when stored IDs collide', async () => {
    const item = { id: 'same', text: 'First', completed: false, createdAt: 1 };
    vi.mocked(getProjectContext).mockResolvedValue({ ...empty, todos: [item, { ...item, text: 'Second' }] });
    const view = await render();
    expect(view.textContent).toContain('Editing is disabled');
    expect((view.querySelector('[aria-label="New project todo"]') as HTMLInputElement).disabled).toBe(true);
  });
});
