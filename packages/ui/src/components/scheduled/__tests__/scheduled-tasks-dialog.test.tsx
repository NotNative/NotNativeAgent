// SPDX-License-Identifier: Apache-2.0
/**
 * @vitest-environment jsdom
 * ScheduledTasksDialog pins (doc 12 §H): project default-selection rides the
 * active directory, 404 = empty-not-error, loop tasks toggle through the
 * loop-file route while plain tasks upsert, run-now toasts by outcome
 * (including the 200 ok:false body), plain delete is immediate while the
 * loop delete confirms, the loop-file handoff dispatches nnd:files-open only
 * inside the worktree, and a C.10 frame refreshes the list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(), success: vi.fn(), message: vi.fn(), dismiss: vi.fn(),
  }),
}));
const captured = vi.hoisted(() => ({
  listener: null as ((frame: unknown) => void) | null,
  // Every live frame sink per subscription call; closers/gates surface the
  // teardown and late-resolution edges the hook must survive.
  listeners: [] as Array<(frame: unknown) => void>,
  closers: [] as Array<() => void>,
  resolveSubscribe: [] as Array<(close: () => void) => void>,
}));
vi.mock('../../../lib/scheduled-tasks-api.ts', () => ({
  listScheduledTasks: vi.fn(), upsertScheduledTask: vi.fn(), deleteScheduledTask: vi.fn(),
  setLoopFileEnabled: vi.fn(), deleteLoopFile: vi.fn(), runScheduledTask: vi.fn(),
  parseTaskRunEvent: vi.fn(), SCHEDULED_TASK_RAN: 'notnative:scheduled-task-ran',
}));
vi.mock('../../../lib/nnd/events.ts', () => ({
  subscribeControlEvents: vi.fn((onEvent: unknown) => new Promise((resolve) => {
    captured.listener = onEvent as (frame: unknown) => void;
    captured.listeners.push(captured.listener);
    captured.resolveSubscribe.push(resolve as (close: () => void) => void);
  })),
}));

import { toast } from 'sonner';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import {
  deleteLoopFile, deleteScheduledTask, listScheduledTasks, parseTaskRunEvent,
  runScheduledTask, setLoopFileEnabled, upsertScheduledTask,
  type ScheduledTaskView,
} from '../../../lib/scheduled-tasks-api.ts';
import { ScheduledTasksDialog, FILES_OPEN_EVENT } from '../scheduled-tasks-dialog.tsx';
import { useGlobalSyncStore } from '../../../sync/global-stores.ts';

const listMock = listScheduledTasks as unknown as Mock;
const upsertMock = upsertScheduledTask as unknown as Mock;
const deleteMock = deleteScheduledTask as unknown as Mock;
const loopPatchMock = setLoopFileEnabled as unknown as Mock;
const loopDeleteMock = deleteLoopFile as unknown as Mock;
const runMock = runScheduledTask as unknown as Mock;
const parseMock = parseTaskRunEvent as unknown as Mock;

let container: HTMLElement | null = null;
let rootHandle: Root | null = null;

function task(id: string, patch: Record<string, unknown> = {}): ScheduledTaskView {
  return {
    id, name: `task ${id}`, enabled: true,
    schedule: { kind: 'daily', times: ['09:00'], timezone: 'UTC' },
    execution: { prompt: 'do', providerID: 'mock', modelID: 'm' },
    state: { createdAt: 1, updatedAt: 2, lastStatus: 'idle', nextRunAt: 1_800_000_000_000, lastRunAt: 1_799_000_000_000 },
    ...patch,
  } as ScheduledTaskView;
}

const PROJECTS = [
  { id: 'proj1', worktree: 'C:/repo1' },
  { id: 'proj2', worktree: 'C:/repo2' },
];

async function render(directory = 'C:/repo2'): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  rootHandle = createRoot(container);
  await act(async () => {
    rootHandle!.render(<ScheduledTasksDialog directory={directory} onClose={() => { closed = true; }} />);
    await Promise.resolve();
  });
  await settle();
}

async function settle(ms = 20): Promise<void> {
  await act(async () => { await new Promise((done) => setTimeout(done, ms)); });
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
  await settle();
}

let closed = false;

function row(index: number): HTMLElement {
  const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="scheduled-task-row"]')];
  expect(rows.length, 'row present').toBeGreaterThan(index);
  return rows[index]!;
}

function byTestID(scope: Element, testId: string): HTMLElement {
  const found = scope.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  expect(found, `${testId} in row`).toBeDefined();
  return found!;
}

beforeEach(() => {
  closed = false;
  captured.listener = null;
  captured.listeners = [];
  captured.closers = [];
  captured.resolveSubscribe = [];
  useGlobalSyncStore.setState({ projects: PROJECTS });
  listMock.mockReset().mockResolvedValue({ ok: true, tasks: [] });
  upsertMock.mockReset().mockResolvedValue({ ok: true, task: {} });
  deleteMock.mockReset().mockResolvedValue({ ok: true, tasks: [] });
  loopPatchMock.mockReset().mockResolvedValue({ ok: true, task: {} });
  loopDeleteMock.mockReset().mockResolvedValue({ ok: true, tasks: [] });
  runMock.mockReset().mockResolvedValue({ ok: true, status: 'success', task: {} });
  parseMock.mockReset().mockReturnValue(null);
  (toast as unknown as Mock).mockClear();
  (toast.error as unknown as Mock).mockClear();
  (toast.success as unknown as Mock).mockClear();
  (toast.message as unknown as Mock).mockClear();
});

afterEach(async () => {
  await act(async () => {
    rootHandle?.unmount();
    rootHandle = null;
  });
  container?.remove();
  container = null;
  useGlobalSyncStore.setState({ projects: [] });
});

describe('ScheduledTasksDialog (doc 12 §H rows)', () => {
  it('lists tasks with schedule summaries, badges, and run stamps', async () => {
    listMock.mockResolvedValue({ ok: true, tasks: [
      task('t1'),
      task('t2', {
        name: 'night loop', enabled: false, loopFile: 'C:/repo2/.agents/loops/night.md',
        schedule: { kind: 'cron', cron: '30 9 * * *', timezone: 'Europe/Berlin' },
        state: { createdAt: 1, updatedAt: 2, lastStatus: 'error' },
      }),
    ] });
    await render();
    const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="scheduled-task-row"]')];
    expect(rows.length).toBe(2);
    expect(document.body.textContent).toContain('daily 09:00 · UTC');
    expect(document.body.textContent).toContain('cron 30 9 * * * · Europe/Berlin');
    expect(row(0).textContent).toContain('idle');
    expect(row(0).textContent).toContain('next');
    expect(row(1).textContent).toContain('error');
    expect(byTestID(row(1), 'task-loop-chip')).toBeDefined();
    expect(byTestID(row(1), 'task-toggle').textContent).toBe('off');
  });

  it('defaults to the project of the active directory', async () => {
    await render('C:/repo1');
    expect(listMock.mock.calls[0]?.[0]).toBe('proj1');
    const selects = [...document.querySelectorAll<HTMLSelectElement>('[data-testid="scheduled-project-select"]')];
    expect(selects[0]!.value).toBe('proj1');
  });

  it('renders an unknown project (no store yet) as empty, not broken', async () => {
    listMock.mockResolvedValue({ ok: false, status: 404, error: 'unknown project' });
    await render('C:/ghost');
    expect(document.querySelector('[data-testid="scheduled-empty"]')?.textContent).toContain('No scheduled tasks');
    expect(document.querySelector('[data-testid="scheduled-error"]')).toBeNull();
  });

  it('toggles a plain task by upsert and refreshes', async () => {
    listMock.mockResolvedValue({ ok: true, tasks: [task('t1', { enabled: true })] });
    await render();
    await click(byTestID(row(0), 'task-toggle'));
    expect(upsertMock.mock.calls[0]?.[1]).toMatchObject({ id: 't1', enabled: false });
    expect(listMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('toggles a loop task through the loop-file route instead', async () => {
    listMock.mockResolvedValue({ ok: true, tasks: [task('t1', {
      loopFile: 'C:/repo2/.agents/loops/daily.md', enabled: true,
    })] });
    await render();
    await click(byTestID(row(0), 'task-toggle'));
    expect(loopPatchMock.mock.calls[0]).toEqual(['proj2', 't1', false]);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('run-now toasts success, refusals, and the 200 ok:false body distinctly', async () => {
    listMock.mockResolvedValue({ ok: true, tasks: [task('t1')] });
    await render();
    runMock.mockResolvedValueOnce({ ok: true, status: 'success', task: {} });
    await click(byTestID(row(0), 'task-run'));
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('completed'));
    runMock.mockResolvedValueOnce({ ok: false, status: 409, error: 'task is already running or queued' });
    await click(byTestID(row(0), 'task-run'));
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('already running'));
    runMock.mockResolvedValueOnce({ ok: false, status: 'error', task: { id: 't1' } });
    await click(byTestID(row(0), 'task-run'));
    expect(toast.message).toHaveBeenCalledWith(expect.stringContaining('ended with error'));
  });

  it('deletes a plain task immediately and lets run failures toast', async () => {
    listMock.mockResolvedValue({ ok: true, tasks: [task('t1'), task('t2')] });
    await render();
    await click(byTestID(row(0), 'task-delete'));
    expect(deleteMock.mock.calls[0]).toEqual(['proj2', 't1']);
    deleteMock.mockResolvedValueOnce({ ok: false, status: 400, error: 'nope' });
    await click(byTestID(row(0), 'task-delete'));
    expect(toast.error).toHaveBeenCalledWith('nope');
  });

  it('a loop delete confirms before removing the file', async () => {
    listMock.mockResolvedValue({ ok: true, tasks: [task('t1', { loopFile: 'C:/repo2/.agents/loops/daily.md' })] });
    await render();
    await click(byTestID(row(0), 'task-delete'));
    expect(loopDeleteMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('delete file?');
    await click(byTestID(row(0), 'task-loop-confirm'));
    expect(loopDeleteMock.mock.calls[0]).toEqual(['proj2', 't1']);
  });

  it('hands an inside-worktree loop file to the editor event', async () => {
    listMock.mockResolvedValue({ ok: true, tasks: [task('t1', { loopFile: 'C:\\repo2\\.agents\\loops\\daily.md' })] });
    await render();
    const seen: Array<{ directory: string; path: string }> = [];
    const listener = (event: Event): void => {
      seen.push((event as CustomEvent<{ directory: string; path: string }>).detail);
    };
    window.addEventListener(FILES_OPEN_EVENT, listener);
    await click(byTestID(row(0), 'task-loop-edit'));
    window.removeEventListener(FILES_OPEN_EVENT, listener);
    expect(seen[0]).toEqual({ directory: 'C:/repo2', path: '.agents/loops/daily.md' });
  });

  it('a C.10 frame on this project refreshes the list', async () => {
    listMock.mockResolvedValue({ ok: true, tasks: [task('t1')] });
    await render();
    expect(captured.listener).not.toBeNull();
    parseMock.mockReturnValueOnce({ projectId: 'proj2', taskId: 't1', ranAt: 9, status: 'success' });
    const calls = listMock.mock.calls.length;
    await act(async () => {
      captured.listener?.({ type: 'notnative:scheduled-task-ran', properties: {} });
      await Promise.resolve();
    });
    await settle();
    expect(listMock.mock.calls.length).toBeGreaterThan(calls);
  });

  it('Escape closes and a change project reloads', async () => {
    listMock.mockResolvedValue({ ok: true, tasks: [] });
    await render();
    const dialog = document.querySelector('[data-testid="scheduled-tasks-dialog"]')!;
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await Promise.resolve();
    });
    expect(closed).toBe(true);
    listMock.mockClear();
    await act(async () => {
      const select = document.querySelector<HTMLSelectElement>('[data-testid="scheduled-project-select"]')!;
      select.value = 'proj1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    await settle();
    expect(listMock.mock.calls.at(-1)?.[0]).toBe('proj1');
  });
});

describe('ScheduledTasksDialog staleness + contract edges (audit pins)', () => {
  function changeTo(id: string): void {
    const select = document.querySelector<HTMLSelectElement>('[data-testid="scheduled-project-select"]')!;
    select.value = id;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  it('a delayed load of a PREVIOUS project cannot repopulate the switched view', async () => {
    let release: (value: unknown) => void = () => undefined;
    listMock.mockImplementation((id: string) => {
      if (id === 'proj1') return Promise.resolve({ ok: true, tasks: [] });
      return new Promise((resolve) => { release = resolve; }); // the proj2 load hangs mid-flight
    });
    await render();
    await act(async () => { changeTo('proj1'); await Promise.resolve(); });
    await settle();
    expect(listMock.mock.calls.at(-1)?.[0]).toBe('proj1');
    // the stale proj2 resolution lands LAST: it must not own the proj1 view
    await act(async () => { release({ ok: true, tasks: [task('stale-t1')] }); await Promise.resolve(); });
    await settle();
    expect(document.querySelectorAll('[data-testid="scheduled-task-row"]').length).toBe(0);
  });

  it('a frame arriving through a cancelled-but-pending subscription loads nothing stale', async () => {
    listMock.mockResolvedValue({ ok: true, tasks: [] });
    await render();
    await act(async () => { changeTo('proj1'); await Promise.resolve(); });
    await settle();
    expect(listMock.mock.calls.length).toBe(2);
    parseMock.mockReturnValueOnce({ projectId: 'proj2', taskId: 't9', ranAt: 9, status: 'error' });
    await act(async () => {
      captured.listeners[0]?.({ type: 'notnative:scheduled-task-ran', properties: {} });
      await Promise.resolve();
    });
    await settle();
    expect(listMock.mock.calls.length).toBe(2); // the OLD project is not reloaded into the new view
  });

  it('switching projects unsubscribes the previous live refresh', async () => {
    listMock.mockResolvedValue({ ok: true, tasks: [] });
    await render();
    expect(captured.resolveSubscribe).toHaveLength(1);
    const closer0 = vi.fn();
    await act(async () => { captured.resolveSubscribe[0]!(closer0); await Promise.resolve(); });
    await act(async () => { changeTo('proj1'); await Promise.resolve(); });
    await settle();
    expect(closer0).toHaveBeenCalledTimes(1);
    expect(captured.resolveSubscribe).toHaveLength(2);
  });

  it('a subscription resolving after teardown still executes its close', async () => {
    listMock.mockResolvedValue({ ok: true, tasks: [] });
    await render();
    expect(captured.resolveSubscribe.length).toBe(1);
    await act(async () => { rootHandle!.unmount(); await Promise.resolve(); });
    rootHandle = null; // the shared afterEach unmount no-ops
    const closer = vi.fn();
    await act(async () => { captured.resolveSubscribe[0]!(closer); await Promise.resolve(); });
    expect(closer).toHaveBeenCalledTimes(1);
  });

  it('the handoff targets the ACTIVE editor root, not the selected worktree', async () => {
    listMock.mockResolvedValue({ ok: true, tasks: [task('t1', { loopFile: 'C:\\repo2\\.agents\\loops\\daily.md' })] });
    await render('C:/repo2/sub'); // session inside the worktree subfolder
    await act(async () => { changeTo('proj2'); await Promise.resolve(); }); // worktree C:/repo2
    await settle();
    const seen: Array<{ directory: string; path: string }> = [];
    const listener = (event: Event): void => {
      seen.push((event as CustomEvent<{ directory: string; path: string }>).detail);
    };
    window.addEventListener(FILES_OPEN_EVENT, listener);
    const edit = byTestID(row(0), 'task-loop-edit') as HTMLButtonElement;
    expect(edit.disabled).toBe(true); // the editor pane root is C:/repo2/sub - it cannot open this file
    await click(edit);
    window.removeEventListener(FILES_OPEN_EVENT, listener);
    expect(seen).toHaveLength(0);
  });

  it('a file under ANOTHER project worktree never reaches the active-root editor', async () => {
    listMock.mockResolvedValue({ ok: true, tasks: [task('t1', { loopFile: 'C:\\repo1\\.agents\\loops\\daily.md' })] });
    await render(); // active root is C:/repo2
    await act(async () => { changeTo('proj1'); await Promise.resolve(); }); // file's project, worktree C:/repo1
    await settle();
    const seen: unknown[] = [];
    const listener = (event: Event): void => { seen.push((event as CustomEvent).detail); };
    window.addEventListener(FILES_OPEN_EVENT, listener);
    const edit = byTestID(row(0), 'task-loop-edit') as HTMLButtonElement;
    expect(edit.disabled).toBe(true);
    await click(edit);
    window.removeEventListener(FILES_OPEN_EVENT, listener);
    expect(seen).toHaveLength(0);
  });

  it('a loop-file 404 toggle toasts the refusal and refetches (no upsert, no lie)', async () => {
    listMock.mockResolvedValue({ ok: true, tasks: [task('t1', { loopFile: 'C:/repo2/.agents/loops/daily.md' })] });
    await render();
    loopPatchMock.mockResolvedValueOnce({ ok: false, status: 404, error: 'loop file is gone' });
    await click(byTestID(row(0), 'task-toggle'));
    expect(toast.error).toHaveBeenCalledWith('loop file is gone');
    expect(upsertMock).not.toHaveBeenCalled();
    expect(listMock.mock.calls.length).toBeGreaterThan(1); // the badge is corrected from server truth
  });

  it('a confirmed loop delete prunes the row via the fresh list', async () => {
    listMock.mockResolvedValueOnce({ ok: true, tasks: [task('t1', { loopFile: 'C:/repo2/.agents/loops/daily.md' })] });
    listMock.mockResolvedValueOnce({ ok: true, tasks: [] });
    await render();
    await click(byTestID(row(0), 'task-delete')); // arms the confirm chip
    await click(byTestID(row(0), 'task-loop-confirm'));
    expect(loopDeleteMock.mock.calls[0]).toEqual(['proj2', 't1']);
    expect(document.querySelectorAll('[data-testid="scheduled-task-row"]').length).toBe(0);
  });

  it('labels ride the server weekday convention (0=Sunday) and the once form', async () => {
    listMock.mockResolvedValue({ ok: true, tasks: [
      task('w1', { schedule: { kind: 'weekly', times: ['09:00'], weekdays: [0, 6], timezone: 'UTC' } }),
      task('o1', { schedule: { kind: 'once', date: '2026-09-30', time: '08:15', timezone: 'UTC' } }),
    ] });
    await render();
    expect(document.body.textContent).toContain('weekly Sun,Sat at 09:00 · UTC');
    expect(document.body.textContent).toContain('once 2026-09-30 08:15 · UTC');
  });
});
