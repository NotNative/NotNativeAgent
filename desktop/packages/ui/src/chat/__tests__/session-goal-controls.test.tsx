// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { INITIAL_STATE, type DirectoryStore } from '../../sync/types.ts';

const actions = vi.hoisted(() => ({
  load: vi.fn(), save: vi.fn(), objective: vi.fn(), status: vi.fn(), clear: vi.fn(),
}));
vi.mock('../session-goal-actions.ts', () => ({
  loadSessionGoal: actions.load, saveSessionGoal: actions.save,
  effectiveObjective: actions.objective, changeGoalStatus: actions.status,
  clearSessionGoal: actions.clear,
}));
import { SessionGoalControls } from '../session-goal-controls.tsx';

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean | undefined; }
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
const store = createStore<DirectoryStore>((set) => ({
  ...INITIAL_STATE,
  patch: (partial) => set(partial),
  replace: (next) => set(next),
}));

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<SessionGoalControls sessionID="ses_goal" store={store} />); });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null; root = null;
  vi.clearAllMocks();
  store.setState({ ...INITIAL_STATE });
});

describe('session goal controls', () => {
  it('loads a root session goal and keeps the editor behind an explicit toggle', async () => {
    actions.load.mockResolvedValue({ goal: null, revision: 0 });
    await mount();
    expect(container!.textContent).toContain('No goal for this session');
    expect(container!.querySelector('textarea')).toBeNull();
    await act(async () => { (container!.querySelector('button') as HTMLButtonElement).click(); });
    expect(container!.querySelector('textarea')).not.toBeNull();
    expect(container!.textContent).toContain('an armed goal self-continues');
    expect(actions.load).toHaveBeenCalledWith('ses_goal');
  });

  it('saves edited objective only on explicit click and closes on success', async () => {
    actions.load.mockResolvedValue({ goal: null, revision: 0 });
    actions.save.mockResolvedValue({ goal: { id: 'goal1', status: 'active', objective: 'Build NND', tokensUsed: 0, turnsUsed: 0, tokenBudget: null }, revision: 1 });
    await mount();
    await act(async () => { (container!.querySelector('button') as HTMLButtonElement).click(); });
    const input = container!.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Build NND');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(actions.save).not.toHaveBeenCalled();
    const save = [...container!.querySelectorAll('button')].find((button) => button.textContent === 'Save goal')!;
    await act(async () => { save.click(); });
    expect(actions.save).toHaveBeenCalledWith('ses_goal', 'Build NND', null);
    expect(container!.querySelector('textarea')).toBeNull();
    expect(container!.textContent).toContain('Goal · active');
  });

  it('shows the live continuation count inside the goal editor', async () => {
    actions.load.mockResolvedValueOnce({ goal: { id: 'g1', status: 'active', objective: 'Build NND',
      tokensUsed: 40, turnsUsed: 3, tokenBudget: null }, revision: 1 });
    actions.load.mockResolvedValueOnce({ goal: { id: 'g1', status: 'complete', objective: 'Build NND',
      tokensUsed: 49, turnsUsed: 3, tokenBudget: null }, revision: 2 });
    actions.objective.mockResolvedValue('Build NND');
    await mount();
    const manage = [...container!.querySelectorAll('button')].find((button) => button.textContent === 'Manage')!;
    await act(async () => { manage.click(); });
    expect(container!.textContent).toContain('Auto-continuations used: 3 of 20.');
    expect(container!.textContent).toContain('Completion needs an independent audit.');
    await act(async () => {
      store.setState({ session: [{ id: 'ses_goal', slug: 'ses_goal', projectID: 'p', directory: '/work',
        title: 'Goal', version: '1', tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 2 }, metadata: { nnd: { goalRevision: 2 } } }] });
    });
    await act(async () => {});
    expect(container!.textContent).toContain('Goal · complete');
    expect(container!.textContent).toContain('Auto-continuations used: 3 of 20.');
    expect(container!.textContent).not.toContain('Completion needs an independent audit.');
  });

  it('refreshes the strip when the live session goal revision changes', async () => {
    actions.load.mockResolvedValueOnce({ goal: { id: 'g1', status: 'active', objective: 'Build', tokensUsed: 0, turnsUsed: 0, tokenBudget: null }, revision: 0 });
    actions.load.mockResolvedValueOnce({ goal: { id: 'g1', status: 'complete', objective: 'Build', tokensUsed: 9, turnsUsed: 3, tokenBudget: null }, revision: 1 });
    await mount();
    expect(container!.textContent).toContain('Goal · active');
    await act(async () => {
      store.setState({ session: [{ id: 'ses_goal', slug: 'ses_goal', projectID: 'p', directory: '/work',
        title: 'Goal', version: '1', tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 2 }, metadata: { nnd: { goalRevision: 1 } } }] });
    });
    expect(container!.textContent).toContain('Goal · complete');
    expect(container!.textContent).toContain('9 tokens');
  });

  it('refreshes from the global session revision when the directory cache is cold', async () => {
    actions.load.mockResolvedValueOnce({ goal: null, revision: 0 });
    actions.load.mockResolvedValueOnce({ goal: { id: 'g1', status: 'active', objective: 'Remote goal', tokensUsed: 0, turnsUsed: 0, tokenBudget: null }, revision: 1 });
    await mount();
    expect(container!.textContent).toContain('No goal for this session');
    await act(async () => { root!.render(<SessionGoalControls sessionID="ses_goal" store={store} externalRevision={1} />); });
    expect(container!.textContent).toContain('Remote goal');
  });

  it('does not overwrite a user edit with a late objective-file read', async () => {
    let resolveObjective!: (value: string) => void;
    actions.load.mockResolvedValue({ goal: { id: 'g1', status: 'active', objective: 'Original', tokensUsed: 0, turnsUsed: 0, tokenBudget: null }, revision: 0 });
    actions.objective.mockReturnValue(new Promise<string>((resolve) => { resolveObjective = resolve; }));
    await mount();
    await act(async () => { [...container!.querySelectorAll('button')].find((button) => button.textContent === 'Manage')!.click(); });
    const input = container!.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'User edit');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { resolveObjective('Old file content'); });
    expect(input.value).toBe('User edit');
  });
});
