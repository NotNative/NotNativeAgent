// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { toast } from 'sonner';
import type { ComposerServices } from '../../../chat/composer.tsx';
import type { Session } from '../../../lib/nnd/types.ts';
import { harnessClient } from '../../../lib/nnd/client.ts';
import { useGlobalSessionStatusStore } from '../../../sync/global-stores.ts';
import { useSessionViewStore } from '../../../sync/view-store.ts';
import { I18nProvider } from '../../../lib/i18n/context.tsx';
import { useAgentGroupsStore } from '../../../lib/agent-groups/store.ts';
import { AgentManagerView } from '../AgentManagerView.tsx';

vi.mock('../../../lib/server-api.ts', () => ({
  listWorktrees: vi.fn(),
  removeWorktree: vi.fn(),
}));

const serverApi = await import('../../../lib/server-api.ts');

const deleteSessionMock = vi.fn();

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function session(id: string, directory: string): Session {
  return {
    id,
    slug: 'rework/openai/gpt',
    projectID: 'project',
    directory,
    title: 'rework/openai/gpt',
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    version: '1',
    time: { created: 10, updated: 10 },
  } as never;
}

function groupEntry(id: string): {
  session: Session;
  worktreePath: string;
  worktreeBranch: string | null;
} {
  return { session: session(id, `C:/wt-${id}`), worktreePath: `C:/wt-${id}`, worktreeBranch: id };
}

function snapshot(groups: Array<ReturnType<typeof groupEntry>>): void {
  const now = Date.now();
  useAgentGroupsStore.setState({
    projects: {
      'C:/project': {
        status: 'ready',
        groups: [{ name: 'rework', sessions: groups, lastActive: 10, sessionCount: groups.length }],
        errors: [],
        loadedAt: now,
        generation: 1,
      },
    },
  });
}

function render(props: {
  currentDirectory: string;
  services: ComposerServices;
  onOpenSession?: (session: Session) => void;
}): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(
    <I18nProvider>
      <AgentManagerView
        currentDirectory={props.currentDirectory}
        onClose={vi.fn()}
        onOpenSession={props.onOpenSession ?? vi.fn()}
        projectRoot="C:/project"
        services={props.services}
      />,
    </I18nProvider>
  ));
}

function click(target: Element | null): void {
  if (target === null || !(target instanceof HTMLButtonElement) && !(target instanceof HTMLInputElement)) {
    throw new Error('expected clickable element');
  }
  target.click();
}

function runClick(selector: string): Promise<void> {
  return act(async () => {
    click(container?.querySelector(selector) ?? null);
    for (let tick = 0; tick < 8; tick += 1) {
      await Promise.resolve();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    }
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useAgentGroupsStore.setState({ projects: {} });
  useGlobalSessionStatusStore.setState({ statusById: {}, activeSessionIds: [] });
  useSessionViewStore.setState({ activeDirectory: 'C:/wt-good/nested', currentSessionId: 'good' });
  (serverApi.listWorktrees as unknown as Mock).mockResolvedValue([]);
  vi.spyOn(harnessClient, 'listSessions').mockResolvedValue({ data: [] });
  vi.spyOn(toast, 'error').mockReturnValue('toast-id' as never);
  window.confirm = vi.fn(() => true);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.restoreAllMocks();
});

it('renders groups, active dots, and permits selection', () => {
  const good = groupEntry('good');
  const quiet = groupEntry('quiet');
  snapshot([good, quiet]);
  useGlobalSessionStatusStore.setState({
    statusById: { good: { type: 'running' } as never, quiet: { type: 'idle' } as never },
    activeSessionIds: ['good'],
  });
  const onOpenSession = vi.fn();
  render({
    currentDirectory: 'C:/wt-good/nested',
    onOpenSession,
    services: { engine: { actions: {}, manager: {} } } as unknown as ComposerServices,
  });

  expect(container?.querySelectorAll('[data-testid="agent-group"]')).toHaveLength(1);
  expect(container?.querySelectorAll('[data-testid="agent-run"]')).toHaveLength(2);
  expect(container?.querySelectorAll('[data-testid="agent-active-dot"]')).toHaveLength(1);
  expect(container?.querySelectorAll('[data-testid="agent-run-select"]')[0]?.hasAttribute('checked')).toBe(false);
  act(() => click(container?.querySelectorAll('[data-testid="agent-run-select"]')[0] ?? null));
  expect(container?.querySelector('[data-testid="agent-remove-sessions"]')?.hasAttribute('disabled')).toBe(false);
  const openChat = [...(container?.querySelectorAll('[data-testid="agent-run"] button') ?? [])].find((button) => button.textContent === 'Open chat');
  act(() => click(openChat ?? null));
  expect(onOpenSession).toHaveBeenCalledWith(good.session);
});

it('clears selections whose projected run no longer exists', () => {
  const good = groupEntry('good');
  const quiet = groupEntry('quiet');
  snapshot([good, quiet]);
  render({
    currentDirectory: 'C:/project',
    services: { engine: { actions: {}, manager: {} } } as unknown as ComposerServices,
  });
  act(() => click(container?.querySelectorAll('[data-testid="agent-run-select"]')[0] ?? null));
  act(() => snapshot([quiet]));
  expect(container?.querySelectorAll('[data-testid="agent-run-select"]')).toHaveLength(1);
  expect(container?.querySelector('[data-testid="agent-run-select"]')?.hasAttribute('checked')).toBe(false);
  expect(container?.querySelector('[data-testid="agent-remove-sessions"]')?.hasAttribute('disabled')).toBe(true);
});

it('deletes selected sessions, forces local branch cleanup, disposes reads, and resets the current directory', async () => {
  deleteSessionMock.mockResolvedValue(undefined);
  (serverApi.removeWorktree as unknown as Mock).mockResolvedValue({ ok: true, branch: null });
  snapshot([groupEntry('good')]);
  const deleteSessionAction = vi.fn(async () => undefined);
  const disposeDirectory = vi.fn();
  render({
    currentDirectory: 'C:/wt-good/nested',
    services: {
      engine: { actions: { deleteSession: deleteSessionAction }, manager: { disposeDirectory } },
    } as unknown as ComposerServices,
  });
  act(() => click(container?.querySelector('[data-testid="agent-run-select"]') ?? null));
  await runClick('[data-testid="agent-remove-worktrees"]');

  expect(window.confirm).toHaveBeenCalledWith('Delete 1 selected session(s) and their worktrees?');
  expect(deleteSessionAction).toHaveBeenCalledWith('good', 'C:/wt-good');
  expect(serverApi.removeWorktree).toHaveBeenCalledWith('C:/project', 'C:/wt-good', true);
  expect(disposeDirectory).toHaveBeenCalledWith('C:/wt-good');
  expect(useSessionViewStore.getState()).toMatchObject({
    activeDirectory: 'C:/project',
    currentSessionId: null,
  });
  expect(useAgentGroupsStore.getState().projects['C:/project']).toMatchObject({
    status: 'ready',
    groups: [],
  });
  expect(((toast.error as unknown) as Mock).mock.calls.flat().map((message: unknown) => String(message)))
    .toContain('Removed 2 item(s); 1 failed: C:/wt-good: Failed to delete local branch good');
});

it('keeps groups when the worktree cleanup API reports failure', async () => {
  (serverApi.removeWorktree as unknown as Mock).mockResolvedValue({ ok: false, error: 'dirty worktree' });
  snapshot([groupEntry('good')]);
  const disposeDirectory = vi.fn();
  render({
    currentDirectory: 'C:/project',
    services: {
      engine: { actions: { deleteSession: deleteSessionMock }, manager: { disposeDirectory } },
    } as unknown as ComposerServices,
  });
  act(() => click(container?.querySelector('[data-testid="agent-run-select"]') ?? null));
  await runClick('[data-testid="agent-remove-worktrees"]');

  expect(disposeDirectory).not.toHaveBeenCalled();
  const toastMessages = ((toast.error as unknown) as Mock).mock.calls.flat().map((message: unknown) => String(message));
  expect(toastMessages).toContain('Removed 1 item(s); 1 failed: C:/wt-good: dirty worktree');
  expect(useSessionViewStore.getState()).toMatchObject({
    activeDirectory: 'C:/wt-good/nested',
    currentSessionId: 'good',
  });
});
