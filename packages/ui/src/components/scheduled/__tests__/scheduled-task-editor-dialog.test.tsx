// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Scheduled-task editor dialog pins (doc 12 §H rendered through E-09-28):
 * create seeds the first catalog pair and PUTs with NO state key; the edit
 * path preserves id/state/loopFile/unknown fields and drops goal fields
 * with the toggle; variant survives only when the provider/model pair is
 * kept; prompt autocompletes ride the composer primitives (@file via
 * fsSearch, / via the command registry); Escape in the nested editor
 * closes only the editor (the tasks overlay stays); the tasks dialog's
 * entry points ride the services prop and refresh the list after a save.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  ScheduledTaskEditorDialog,
} from '../scheduled-task-editor-dialog.tsx';
import { ScheduledTasksDialog } from '../scheduled-tasks-dialog.tsx';
import {
  listScheduledTasks, upsertScheduledTask, previewNextRuns,
  type ScheduledTaskView, type TaskSchedule,
} from '../../../lib/scheduled-tasks-api.ts';
import { fsSearch } from '../../../lib/server-api.ts';
import type { ComposerServices } from '../../../chat/composer.tsx';
import { useGlobalSyncStore } from '../../../sync/global-stores.ts';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(), success: vi.fn(), message: vi.fn(), dismiss: vi.fn(),
  }),
}));
vi.mock('../../../lib/scheduled-tasks-api.ts', () => ({
  listScheduledTasks: vi.fn(), upsertScheduledTask: vi.fn(), deleteScheduledTask: vi.fn(),
  setLoopFileEnabled: vi.fn(), deleteLoopFile: vi.fn(), runScheduledTask: vi.fn(),
  previewNextRuns: vi.fn(), parseTaskRunEvent: vi.fn(),
  SCHEDULED_TASK_RAN: 'notnative:scheduled-task-ran',
}));
vi.mock('../../../lib/nnd/events.ts', () => ({
  subscribeControlEvents: vi.fn(() => new Promise(() => undefined)),
}));
vi.mock('../../../lib/server-api.ts', () => ({ fsSearch: vi.fn() }));

const upsert = upsertScheduledTask as unknown as Mock;
const list = listScheduledTasks as unknown as Mock;
const preview = previewNextRuns as unknown as Mock;
const files = fsSearch as unknown as Mock;

const PROVIDERS_STUB: unknown = [
  { id: 'prov1', name: 'Prov One', models: { m1: { id: 'm1' }, m2: { id: 'm2' } } },
  { id: 'prov2', name: 'Prov Two', models: { m3: { id: 'm3' } } },
];

function taskView(): ScheduledTaskView {
  return {
    id: 't1', name: 'daily sync', enabled: true, loopFile: 'C:/repo/.agents/loops/sync.md',
    schedule: { kind: 'daily', times: ['07:30'], timezone: 'UTC' },
    execution: {
      prompt: 'run the sync', providerID: 'prov1', modelID: 'm1',
      agent: 'plan', goalEnabled: true, goalTokenBudget: 5000, variant: 'slow',
    },
    state: { createdAt: 11, updatedAt: 22, lastStatus: 'idle' },
    note: 'unknown rides through',
  } as ScheduledTaskView;
}

/** A vanilla-store stand-in for the directory store: the editor reads only
 * provider/command/agent slices. `setState` re-publishes synchronously. */
function stubStore(state: Record<string, unknown> = {}): {
  subscribe: (listener: () => void) => () => void;
  getState: () => Record<string, unknown>;
  setState: (patch: Record<string, unknown>) => void;
} {
  let current: Record<string, unknown> = { provider: [], command: [], agent: [], ...state };
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getState: () => current,
    setState: (patch) => { current = { ...current, ...patch }; listeners.forEach((listener) => listener()); },
  };
}

function servicesFor(store: { subscribe: (l: () => void) => () => void; getState: () => unknown }): ComposerServices {
  return {
    engine: {} as never,
    store: (() => store) as unknown as ComposerServices['store'],
    dispatch: () => undefined,
  };
}

function catalogStore(): ReturnType<typeof stubStore> {
  return stubStore({
    provider: PROVIDERS_STUB,
    command: [{ name: 'timeline' }, { name: 'compact' }],
    agent: [{ name: 'build' }, { name: 'plan' }],
  });
}

function settle(ms = 20): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

let container: HTMLElement | null = null;
let root: Root | null = null;

function mount(node: ReactNode): void {
  if (root !== null) { const previous = root; act(() => { previous.unmount(); }); root = null; }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root!.render(node); });
}

function unmount(): void {
  if (root !== null) { const closing = root; act(() => { closing.unmount(); }); root = null; }
  if (container !== null) { container.remove(); container = null; }
}

const noSaved = (): void => undefined;

function renderEditor(task: ScheduledTaskView | null, saveSink: (task: ScheduledTaskView) => void = noSaved,
  services: ComposerServices = servicesFor(catalogStore())): void {
  mount(<ScheduledTaskEditorDialog projectId='proj1' directory='C:/repo' task={task}
    services={services} onSaved={saveSink} onClose={() => undefined}
    key={`editor-${task?.id ?? 'new'}`} />);
}

function click(testid: string): void {
  act(() => {
    document.querySelector(`[data-testid="${testid}"]`)!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function setNativeValue(
  node: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string,
): Promise<void> {
  await act(async () => {
    const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
    setter.call(node, value);
    node.dispatchEvent(new window.Event(node instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

function textOf(testid: string): string {
  return document.querySelector(`[data-testid="${testid}"]`)?.textContent ?? '';
}

const DAILY: TaskSchedule = { kind: 'daily', times: ['09:00'], timezone: 'UTC' };

beforeEach(() => {
  upsert.mockReset();
  upsert.mockResolvedValue({
    ok: true,
    task: { id: 't2', name: 'demo', enabled: true, schedule: DAILY, execution: { prompt: '', providerID: '', modelID: '' }, state: {} },
  });
  list.mockReset();
  list.mockResolvedValue({ ok: true, tasks: [] });
  preview.mockReset();
  preview.mockResolvedValue({ ok: true, slots: [] });
  files.mockReset();
  files.mockResolvedValue([]);
});

afterEach(() => { unmount(); });

function editorBody(): Record<string, unknown> {
  // The typed client's second argument IS the task input (JSON.stringify
  // happens inside the apiJson envelope, not at the call site).
  return upsert.mock.calls[upsert.mock.calls.length - 1]![1] as Record<string, unknown>;
}

describe('ScheduledTaskEditorDialog (doc 12 §H, E-09-28)', () => {
  it('create mode seeds the first catalog pair and blocks an empty name save', async () => {
    renderEditor(null);
    expect(textOf('task-editor-dialog')).toContain('New scheduled task');
    const model = document.querySelector('[data-testid="execution-model-select"]') as HTMLSelectElement;
    expect(model.value).toBe('prov1::m1');
    await setNativeValue(document.querySelector('[data-testid="task-name-input"]') as HTMLInputElement, '   ');
    click('task-save');
    expect(textOf('save-blocked')).toContain('a name is required');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('create save PUTs the seeded draft with NO state key', async () => {
    const saved: ScheduledTaskView[] = [];
    renderEditor(null, (task) => { saved.push(task); });
    await setNativeValue(document.querySelector('[data-testid="task-name-input"]') as HTMLInputElement, 'demo');
    await setNativeValue(document.querySelector('[data-testid="task-prompt-input"]') as HTMLTextAreaElement, 'water the plants');
    click('task-save');
    await act(async () => { await settle(); });
    const body = editorBody();
    expect(body.schedule).toEqual({ kind: 'daily', times: ['09:00'], timezone: expect.any(String) });
    expect(body.execution).toEqual({ prompt: 'water the plants', providerID: 'prov1', modelID: 'm1' });
    expect('state' in body).toBe(false);
    expect(saved[0]?.id).toBe('t2');
    expect(toast.success).toHaveBeenCalledWith('task scheduled');
  });

  it('edit save preserves id/state/loopFile/unknown fields and flips enabled', async () => {
    renderEditor(taskView());
    expect((document.querySelector('[data-testid="task-name-input"]') as HTMLInputElement).value).toBe('daily sync');
    expect((document.querySelector('[data-testid="execution-model-select"]') as HTMLSelectElement).value).toBe('prov1::m1');
    expect((document.querySelector('[data-testid="execution-agent-select"]') as HTMLSelectElement).value).toBe('plan');
    expect((document.querySelector('[data-testid="execution-goal"]') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true');
    expect((document.querySelector('[data-testid="execution-goal-budget"]') as HTMLInputElement).value).toBe('5000');
    expect((document.querySelector('[data-testid="task-prompt-input"]') as HTMLTextAreaElement).value).toBe('run the sync');
    click('task-enabled-chip');
    click('task-save');
    await act(async () => { await settle(); });
    const body = editorBody();
    expect(body.enabled).toBe(false);
    expect(body.id).toBe('t1');
    expect(body.loopFile).toBe('C:/repo/.agents/loops/sync.md');
    expect(body.state).toEqual({ createdAt: 11, updatedAt: 22, lastStatus: 'idle' });
    expect(body.note).toBe('unknown rides through');
    expect(toast.success).toHaveBeenCalledWith('task updated');
  });

  it('goal off drops budget; variant survives the kept pair only', async () => {
    renderEditor(taskView());
    click('execution-goal');
    click('task-save');
    await act(async () => { await settle(); });
    let body = editorBody();
    const execution = body.execution as Record<string, unknown>;
    expect(execution.goalEnabled).toBeUndefined();
    expect(execution.goalTokenBudget).toBeUndefined();
    expect(execution.variant).toBe('slow');
    renderEditor(taskView(), noSaved);
    await setNativeValue(document.querySelector('[data-testid="execution-model-select"]') as HTMLSelectElement, 'prov2::m3');
    click('task-save');
    await act(async () => { await settle(); });
    body = editorBody();
    expect(body.execution).toMatchObject({ providerID: 'prov2', modelID: 'm3' });
    expect((body.execution as Record<string, unknown>).variant).toBeUndefined();
  });

  it('Escape with an open picker closes only the picker; the editor stays', async () => {
    files.mockResolvedValue([{ path: 'maintenance.rs' }]);
    renderEditor(taskView());
    const area = document.querySelector('[data-testid="task-prompt-input"]') as HTMLTextAreaElement;
    await setNativeValue(area, 'check @ma');
    await act(async () => { await settle(); });
    expect(document.querySelector('[data-testid="composer-picker"]')).not.toBeNull();
    act(() => {
      area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[data-testid="composer-picker"]')).toBeNull();
    expect(document.querySelector('[data-testid="task-editor-dialog"]')).not.toBeNull();
  });

  it('the schedule editor rides the CLIENT preview function', async () => {
    preview.mockResolvedValue({ ok: true, slots: [1770000000000] });
    renderEditor(taskView());
    // the dialog rides the schedule editor's default 250ms debounce
    await act(async () => { await settle(300); });
    expect(document.querySelectorAll('[data-testid="schedule-preview-slot"]').length).toBe(1);
    expect(preview).toHaveBeenCalled();
  });

  it('prompt / lists the command registry and inserts the token', async () => {
    renderEditor(taskView());
    await setNativeValue(document.querySelector('[data-testid="task-prompt-input"]') as HTMLTextAreaElement, 'do /ti');
    expect(textOf('composer-picker')).toContain('timeline');
    await act(async () => {
      [...document.querySelectorAll('[data-testid="composer-picker"] button')]
        .find((button) => button.textContent === 'timeline')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect((document.querySelector('[data-testid="task-prompt-input"]') as HTMLTextAreaElement).value).toBe('do /timeline ');
    expect(document.querySelector('[data-testid="composer-picker"]')).toBeNull();
  });

  it('prompt @ merges fsSearch paths and inserts the mention', async () => {
    files.mockResolvedValue([{ path: 'maintenance.rs' }, { path: 'maintenance.ts' }]);
    renderEditor(taskView());
    await setNativeValue(document.querySelector('[data-testid="task-prompt-input"]') as HTMLTextAreaElement, 'check @ma');
    await act(async () => { await settle(); });
    expect(textOf('composer-picker')).toContain('maintenance.rs');
    await act(async () => {
      [...document.querySelectorAll('[data-testid="composer-picker"] button')]
        .find((button) => button.textContent === 'maintenance.rs')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect((document.querySelector('[data-testid="task-prompt-input"]') as HTMLTextAreaElement).value).toBe('check @maintenance.rs ');
  });

  it('a failed save folds to the toast and keeps the editor open', async () => {
    // The REAL registered upsert loop-gate text (routes/scheduled-tasks.ts,
    // E-09-23 h): an upsert whose id hits a still-present loop file.
    upsert.mockResolvedValue({
      ok: false, status: 400,
      error: `task is driven by the loop file ${taskView().loopFile}; mutate the file via the loop-file route`,
    });
    renderEditor(taskView());
    click('task-save');
    await act(async () => { await settle(); });
    expect(toast.error).toHaveBeenCalledWith(`task is driven by the loop file ${taskView().loopFile}; mutate the file via the loop-file route`);
    expect(document.querySelector('[data-testid="task-editor-dialog"]')).not.toBeNull();
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('a resolved fsSearch from a swapped-out trigger publishes nothing (kind guard)', async () => {
    let resolveFirst: (files: { path: string }[]) => void = () => undefined;
    files.mockImplementationOnce(() => new Promise((resolve) => {
      resolveFirst = resolve as unknown as (files: { path: string }[]) => void;
    }));
    renderEditor(taskView());
    const area = document.querySelector('[data-testid="task-prompt-input"]') as HTMLTextAreaElement;
    await setNativeValue(area, 'check @ma'); // mention trigger, fsSearch pending
    await setNativeValue(area, 'check #ma'); // the trigger char swapped mid-pending
    await act(async () => {
      resolveFirst([{ path: 'maintenance.rs' }]);
      await settle();
    });
    // the stale mention's fs results must not repopulate the '#' picker
    expect(document.querySelector('[data-testid="composer-picker"]')?.textContent).not.toContain('maintenance.rs');
    // and no kind-mismatched insert may have mutated the document
    expect((document.querySelector('[data-testid="task-prompt-input"]') as HTMLTextAreaElement).value).toBe('check #ma');
  });

  it('stale fsSearch responses after further typing publish nothing (token precision)', async () => {
    let resolveFirst: (files: { path: string }[] ) => void = () => undefined;
    files.mockImplementationOnce(() => new Promise((resolve) => {
      resolveFirst = resolve as unknown as (files: { path: string }[]) => void;
    }));
    renderEditor(taskView());
    const area = document.querySelector('[data-testid="task-prompt-input"]') as HTMLTextAreaElement;
    await setNativeValue(area, 'check @ma'); // 'ma' fsSearch pending (token 1)
    files.mockResolvedValueOnce([{ path: 'maintenance.rs' }]); // the 'mas' response
    await setNativeValue(area, 'check @mas'); // newer mention input bumps the token
    await act(async () => {
      resolveFirst([{ path: 'old-query-hit.rs' }]); // the stale 'ma' response lands late
      await settle();
    });
    expect(document.querySelector('[data-testid="composer-picker"]')?.textContent).not.toContain('old-query-hit.rs');
    expect((document.querySelector('[data-testid="task-prompt-input"]') as HTMLTextAreaElement).value).toBe('check @mas');
  });

  it('dialog re-renders do not re-arm the preview (the draft string keys the effect)', async () => {
    renderEditor(taskView());
    await act(async () => { await settle(300); }); // first preview for the opened draft
    const before = preview.mock.calls.length;
    expect(before).toBeGreaterThan(0);
    await setNativeValue(document.querySelector('[data-testid="task-name-input"]') as HTMLInputElement, 'seven');
    await act(async () => { await settle(300); });
    expect(preview.mock.calls.length).toBe(before); // deps are [draft, delayMs] only
  });

  it('the no-catalog placeholder cannot disturb the draft on pick', async () => {
    renderEditor(null, noSaved, servicesFor(stubStore({ provider: [], command: [], agent: [] })));
    const select = document.querySelector('[data-testid="execution-model-select"]') as HTMLSelectElement;
    expect(select.textContent).toContain('no models configured');
    await setNativeValue(select, ''); // '' has no '::' -> pick() ignores index <= 0
    await setNativeValue(document.querySelector('[data-testid="task-name-input"]') as HTMLInputElement, 'demo');
    click('task-save');
    await act(async () => { await settle(); });
    const body = editorBody();
    expect(body.execution).toEqual({ prompt: '', providerID: '', modelID: '' });
  });

  it('an in-flight save resolving after unmount stays silent (no unmounted-setState error)', async () => {
    let resolveSave: (outcome: unknown) => void = () => undefined;
    upsert.mockImplementationOnce(() => new Promise((resolve) => {
      resolveSave = resolve as unknown as (outcome: unknown) => void;
    }));
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((message: unknown) => { errors.push(String(message)); });
    renderEditor(taskView());
    click('task-save');
    await act(async () => { await settle(); });
    expect(errors).toEqual([]); // the pending save is quiet so far
    act(() => { root!.unmount(); });
    root = null;
    await act(async () => {
      resolveSave({ ok: true, task: taskView() });
      await settle();
    });
    spy.mockRestore();
    expect(errors).toEqual([]); // React 19 no-ops the late setSaving silently
    expect(toast.success).toHaveBeenCalledWith('task updated');
  });

  it('the opened snapshot governs user fields; ride-through fields read the task prop', async () => {
    const opened = taskView();
    const newer: ScheduledTaskView = {
      ...opened, name: 'late fold',
      execution: { ...opened.execution, modelID: 'm2' },
      state: { createdAt: 11, updatedAt: 999, lastStatus: 'success' },
    };
    const services = servicesFor(catalogStore());
    mount(<ScheduledTaskEditorDialog projectId='proj1' directory='C:/repo' task={opened}
      services={services} onSaved={noSaved} onClose={() => undefined} key='editor-t1' />);
    // Registered governance (E-09-28): name/enabled/schedule/execution seed
    // MOUNT-ONCE and never re-seed, while id/state/loopFile/unknowns read the
    // task prop at SAVE time. The real parent passes the stable opened view
    // (a mid-edit C.10 fold rewrites the LIST ROW, never this prop), so both
    // halves coincide with the opened snapshot in every reachable path; a
    // drop-in prop swap is the only way to observe them separately.
    act(() => {
      root!.render(<ScheduledTaskEditorDialog projectId='proj1' directory='C:/repo' task={newer}
        services={services} onSaved={noSaved} onClose={() => undefined} key='editor-t1' />);
    });
    expect((document.querySelector('[data-testid="task-name-input"]') as HTMLInputElement).value).toBe('daily sync');
    await setNativeValue(document.querySelector('[data-testid="task-name-input"]') as HTMLInputElement, 'user edit');
    click('task-save');
    await act(async () => { await settle(); });
    const body = editorBody();
    expect(body.name).toBe('user edit');
    expect(body.state).toEqual({ createdAt: 11, updatedAt: 999, lastStatus: 'success' }); // rides the LIVE prop
    expect((body.execution as Record<string, unknown>).modelID).toBe('m1'); // the mount-seeded opened pair
  });
});

describe('editor entry points in the tasks dialog (E-09-28)', () => {
  beforeEach(() => {
    useGlobalSyncStore.setState({ projects: [{ id: 'proj1', worktree: 'C:/repo' }] });
    list.mockResolvedValue({ ok: true, tasks: [taskView()] });
  });

  function renderTasksDialog(withServices: boolean): void {
    mount(<ScheduledTasksDialog directory='C:/repo' onClose={() => undefined}
      services={withServices ? servicesFor(catalogStore()) : undefined} />);
  }

  it('services present: +new and per-row task buttons open the editor; save refreshes', async () => {
    renderTasksDialog(true);
    await act(async () => { await settle(); });
    expect(document.querySelector('[data-testid="task-new"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="task-edit"]')).not.toBeNull();
    click('task-edit');
    expect(document.querySelector('[data-testid="task-editor-dialog"]')?.textContent).toContain('Edit scheduled task');
    expect((document.querySelector('[data-testid="task-name-input"]') as HTMLInputElement).value).toBe('daily sync');
    click('task-save');
    await act(async () => { await settle(); });
    expect(document.querySelector('[data-testid="task-editor-dialog"]')).toBeNull();
    expect(list.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('Escape in the nested editor closes only the editor; the tasks overlay stays', async () => {
    renderTasksDialog(true);
    await act(async () => { await settle(); });
    click('task-edit');
    expect(document.querySelector('[data-testid="task-editor-dialog"]')).not.toBeNull();
    act(() => {
      document.querySelector('[data-testid="task-editor-dialog"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[data-testid="task-editor-dialog"]')).toBeNull();
    expect(document.querySelector('[data-testid="scheduled-tasks-dialog"]')).not.toBeNull();
  });

  it('services absent: the editor entry points do not render', async () => {
    renderTasksDialog(false);
    await act(async () => { await settle(); });
    expect(document.querySelector('[data-testid="task-new"]')).toBeNull();
    expect(document.querySelector('[data-testid="task-edit"]')).toBeNull();
    expect(document.querySelector('[data-testid="scheduled-tasks-dialog"]')).not.toBeNull();
  });
});
