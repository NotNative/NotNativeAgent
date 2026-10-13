// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { join } from 'node:path';

vi.mock('../../lib/project-context-api.ts', () => ({
  getProjectContext: vi.fn(), getProjectPlan: vi.fn(), createProjectPlan: vi.fn(),
  updateProjectPlan: vi.fn(), deleteProjectPlan: vi.fn(), shareProjectPlan: vi.fn(),
  unshareProjectPlan: vi.fn(),
}));
import { createProjectPlan, deleteProjectPlan, getProjectContext, getProjectPlan,
  shareProjectPlan, unshareProjectPlan, updateProjectPlan } from '../../lib/project-context-api.ts';
import { ContextPlans } from '../context-plans.tsx';

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean | undefined; }
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
const empty = { version: 2 as const, notes: [], todos: [], plans: [] };
const plan = { id: 'p1', file: 'p1.md', title: 'Plan', createdAt: 1 };
const REPO = 'D:/TestRepo';

beforeEach(() => {
  vi.stubGlobal('confirm', vi.fn(() => true));
  vi.mocked(getProjectContext).mockReset().mockResolvedValue(empty);
  vi.mocked(getProjectPlan).mockReset();
  vi.mocked(createProjectPlan).mockReset();
  vi.mocked(updateProjectPlan).mockReset();
  vi.mocked(deleteProjectPlan).mockReset();
  vi.mocked(shareProjectPlan).mockReset();
  vi.mocked(unshareProjectPlan).mockReset();
});
afterEach(() => { act(() => root?.unmount()); container?.remove(); root = null; container = null; vi.unstubAllGlobals(); });

async function render(): Promise<HTMLElement> {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => {
    root!.render(<ContextPlans projectId="project1" directory={REPO} visible />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}
function typeInto(label: string, value: string): void {
  const field = container!.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLTextAreaElement;
  act(() => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function click(label: string): Promise<void> {
  const button = [...container!.querySelectorAll('button')]
    .find((item) => item.textContent === label || item.textContent?.startsWith(label))!;
  if (!button) throw new Error(`missing ${label}`);
  await act(async () => { button.click(); await Promise.resolve(); });
}

describe('NND saved plans panel', () => {
  it('filters plan titles while retaining the create draft and unopened manifests', async () => {
    const second = { ...plan, id: 'p2', file: 'p2.md', title: 'Beta' };
    vi.mocked(getProjectContext).mockResolvedValue({ ...empty, plans: [plan, second] });
    const view = await render();
    typeInto('New plan title', 'Draft title');
    await act(async () => { root!.render(<ContextPlans projectId="project1" directory={REPO} visible query="beta" />); });
    expect([...view.querySelectorAll('ol button')].map((button) => button.textContent?.startsWith('Beta')))
      .toEqual([true]);
    expect((view.querySelector('[aria-label="New plan title"]') as HTMLInputElement).value).toBe('Draft title');
    await act(async () => { root!.render(<ContextPlans projectId="project1" directory={REPO} visible query="" />); });
    expect([...view.querySelectorAll('ol button')].map((button) => button.textContent?.slice(0, 4)))
      .toEqual(['Plan', 'Beta']);
    expect(getProjectContext).toHaveBeenCalledTimes(1);
  });
  it('creates, opens, saves raw markdown, and deletes through committed API responses', async () => {
    const view = await render();
    typeInto('New plan title', 'Plan'); typeInto('New plan body', 'Body');
    vi.mocked(createProjectPlan).mockResolvedValue({ plan, context: { ...empty, plans: [plan] } });
    await click('Create plan');
    expect(createProjectPlan).toHaveBeenCalledWith('project1', { title: 'Plan', body: 'Body' });
    vi.mocked(getProjectPlan).mockResolvedValue({ ...plan, raw: '# Plan\n\nBody', body: 'Body' });
    await click('Plan');
    typeInto('Saved plan markdown', '# Plan\n\nEdited');
    vi.mocked(updateProjectPlan).mockResolvedValue({ plan, raw: '# Plan\n\nEdited' });
    await click('Save plan');
    expect(updateProjectPlan).toHaveBeenCalledWith('project1', 'p1', '# Plan\n\nEdited', REPO);
    vi.mocked(deleteProjectPlan).mockResolvedValue(empty);
    await click('Delete plan');
    expect(deleteProjectPlan).toHaveBeenCalledWith('project1', 'p1', REPO);
    expect(view.textContent).not.toContain('Plan markdown');
  });

  it('preserves a create draft after a failed request and a failed refresh', async () => {
    const view = await render();
    typeInto('New plan title', 'Keep');
    vi.mocked(createProjectPlan).mockRejectedValue(new Error('offline'));
    await click('Create plan');
    expect((view.querySelector('[aria-label="New plan title"]') as HTMLInputElement).value).toBe('Keep');
    expect(view.textContent).toContain('Your draft is still here');
    vi.mocked(getProjectContext).mockRejectedValue(new Error('offline'));
    await click('Refresh');
    expect((view.querySelector('[aria-label="New plan title"]') as HTMLInputElement).value).toBe('Keep');
  });

  it('keeps dirty markdown when opening another plan or closing is cancelled', async () => {
    const second = { ...plan, id: 'p2', file: 'p2.md', title: 'Second' };
    vi.mocked(getProjectContext).mockResolvedValue({ ...empty, plans: [plan, second] });
    vi.mocked(getProjectPlan).mockImplementation(async (_, id) => ({ ...(id === 'p1' ? plan : second), raw: '# Original' }));
    const view = await render();
    await click('Plan');
    typeInto('Saved plan markdown', '# Edited');
    vi.mocked(window.confirm).mockReturnValue(false);
    await click('Second');
    await click('Close');
    expect(getProjectPlan).toHaveBeenCalledTimes(1);
    expect((view.querySelector('[aria-label="Saved plan markdown"]') as HTMLTextAreaElement).value).toBe('# Edited');
    vi.mocked(window.confirm).mockReturnValue(true);
    await click('Second');
    expect((view.querySelector('[aria-label="Saved plan markdown"]') as HTMLTextAreaElement).value).toBe('# Original');
  });

  it('requires confirmation before deletion and updates the list title after saving a heading', async () => {
    vi.mocked(getProjectContext).mockResolvedValue({ ...empty, plans: [plan] });
    vi.mocked(getProjectPlan).mockResolvedValue({ ...plan, raw: '# Plan' });
    const view = await render();
    await click('Plan');
    vi.mocked(window.confirm).mockReturnValue(false);
    await click('Delete plan');
    expect(deleteProjectPlan).not.toHaveBeenCalled();
    typeInto('Saved plan markdown', '# Renamed');
    vi.mocked(updateProjectPlan).mockResolvedValue({ plan: { ...plan, title: 'Renamed' }, raw: '# Renamed' });
    await click('Save plan');
    expect(view.querySelector('ol')?.textContent).toContain('Renamed');
    await click('Close');
    expect(window.confirm).toHaveBeenCalledTimes(1);
  });

  it('shares a manifest plan and unshares the claimed shared plan', async () => {
    vi.mocked(getProjectContext).mockResolvedValue({ ...empty, plans: [plan] });
    const view = await render();
    vi.mocked(getProjectPlan).mockResolvedValue({ ...plan, raw: '# Plan' });
    await click('Plan');
    vi.mocked(shareProjectPlan).mockResolvedValue({
      plan: { ...plan, shared: true, source: 'personal' },
      context: { ...empty, plans: [{ ...plan, shared: true, source: 'personal' }] },
      sharedPlansDir: join(REPO, '.openchamber', 'plans'),
    });
    await click('Share plan');
    expect(shareProjectPlan).toHaveBeenCalledWith('project1', 'p1', REPO);
    expect([...view.querySelectorAll('button')].some((item) => item.textContent === 'Unshare plan')).toBe(true);
    vi.mocked(unshareProjectPlan).mockResolvedValue({
      plan: { ...plan, shared: false, source: 'personal' },
      context: { ...empty, plans: [{ ...plan, shared: false, source: 'personal' }] },
      sharedPlansDir: join(REPO, '.openchamber', 'plans'),
    });
    await click('Unshare plan');
    expect(unshareProjectPlan).toHaveBeenCalledWith('project1', 'p1', REPO);
    expect([...view.querySelectorAll('button')].some((item) => item.textContent === 'Share plan')).toBe(true);
  });

  it('edits an unclaimed shared-plan ID directly and shows its shared source', async () => {
    const sharedPlan = { id: 'shared:team.md', file: 'team.md', title: 'Team', createdAt: 2, source: 'shared' as const };
    vi.mocked(getProjectContext).mockResolvedValue({ ...empty, plans: [sharedPlan] });
    vi.mocked(getProjectPlan).mockResolvedValue({ ...sharedPlan, raw: '# Team' });
    const view = await render();
    expect(view.querySelector('ol')?.textContent).toContain('shared');
    await click('Team');
    typeInto('Saved plan markdown', '# Team edited');
    vi.mocked(updateProjectPlan).mockResolvedValue({ plan: sharedPlan, raw: '# Team edited' });
    await click('Save plan');
    expect(updateProjectPlan).toHaveBeenCalledWith('project1', 'shared:team.md', '# Team edited', REPO);
  });

  it('does not apply an old project plan read after a project switch', async () => {
    vi.mocked(getProjectContext).mockResolvedValue({ ...empty, plans: [plan] });
    let finishRead!: (value: typeof plan & { raw: string }) => void;
    vi.mocked(getProjectPlan).mockReturnValue(new Promise((resolve) => { finishRead = resolve; }));
    const view = await render();
    await click('Plan');
    await act(async () => { root!.render(<ContextPlans projectId="project2" directory={REPO} visible />); await Promise.resolve(); });
    await act(async () => { finishRead({ ...plan, raw: '# Old project' }); await Promise.resolve(); });
    expect(view.querySelector('[aria-label="Saved plan markdown"]')).toBeNull();
    expect((view.querySelector('[aria-label="New plan title"]') as HTMLInputElement).value).toBe('');
  });

  it('does not apply a committed create response to the next project', async () => {
    let finishCreate!: (value: Awaited<ReturnType<typeof createProjectPlan>>) => void;
    vi.mocked(createProjectPlan).mockReturnValue(new Promise((resolve) => { finishCreate = resolve; }));
    const view = await render();
    typeInto('New plan title', 'Old draft');
    await act(async () => { [...view.querySelectorAll('button')].find((item) => item.textContent === 'Create plan')!.click(); });
    await act(async () => { root!.render(<ContextPlans projectId="project2" directory={REPO} visible />); await Promise.resolve(); });
    await act(async () => { finishCreate({ plan, context: { ...empty, plans: [plan] } }); await Promise.resolve(); });
    expect(view.querySelector('ol')?.textContent).toBe('');
    expect((view.querySelector('[aria-label="New plan title"]') as HTMLInputElement).value).toBe('');
  });
});
