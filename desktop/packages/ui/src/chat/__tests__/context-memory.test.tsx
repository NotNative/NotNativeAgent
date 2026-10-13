// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../lib/agent-memory-api.ts', async () => {
  const module = await vi.importActual('../../lib/agent-memory-api.ts');
  return { ...module, listAgentMemory: vi.fn(), updateAgentMemory: vi.fn(), deleteAgentMemory: vi.fn() };
});
vi.mock('../../lib/nnd/events.ts', async () => {
  const module = await vi.importActual('../../lib/nnd/events.ts');
  return { ...module, subscribeControlEvents: vi.fn() };
});
import { deleteAgentMemory, listAgentMemory, updateAgentMemory } from '../../lib/agent-memory-api.ts';
import { AGENT_MEMORY_CHANGED } from '../../lib/agent-memory-events.ts';
import { subscribeControlEvents } from '../../lib/nnd/events.ts';
import { ContextMemory } from '../context-memory.tsx';

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean | undefined; }
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let emitControlEvent: (event: { type: string; properties: Record<string, unknown> }) => void;

const entry = { id: 'm1', title: 'Boundary', body: 'Store memory in NND.', type: 'fact' as const,
  createdAt: 1, updatedAt: 2 };
const overview = { global: [], project: [entry], globalFailed: false, projectFailed: false };

beforeEach(() => {
  vi.stubGlobal('EventSource', class EventSourceStub {});
  vi.stubGlobal('confirm', vi.fn(() => true));
  vi.mocked(listAgentMemory).mockReset().mockResolvedValue(overview);
  vi.mocked(updateAgentMemory).mockReset();
  vi.mocked(deleteAgentMemory).mockReset();
  vi.mocked(subscribeControlEvents).mockReset().mockImplementation((listener) => {
    emitControlEvent = listener;
    return Promise.resolve(() => {});
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove(); root = null; container = null;
  vi.unstubAllGlobals();
});

async function render(): Promise<HTMLElement> {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => {
    root!.render(<ContextMemory projectId="alpha" visible />);
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
    .find((button) => button.textContent === label);
  if (!button) throw new Error(`missing ${label}`);
  await act(async () => { button.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe('agent memory panel', () => {
  it('loads scoped stores, edits the selected entry, and deletes without a create route', async () => {
    const view = await render();
    expect(view.textContent).toContain('Boundary');
    vi.mocked(updateAgentMemory).mockResolvedValue({
      entry: { ...entry, title: 'Boundary rules', body: 'Use an isolated memory home.', type: 'preference' },
      entries: [{ ...entry, title: 'Boundary rules', body: 'Use an isolated memory home.', type: 'preference', flagged: 'threat' }],
    });
    await click('Edit');
    typeInto('Edit memory title', 'Boundary rules');
    typeInto('Edit memory body', 'Use an isolated memory home.');
    await click('Save memory');
    expect(updateAgentMemory).toHaveBeenCalledWith('alpha', 'm1', {
      title: 'Boundary rules', body: 'Use an isolated memory home.', type: 'fact',
    });
    vi.mocked(listAgentMemory).mockResolvedValue({
      ...overview,
      project: [{ ...entry, title: 'Boundary rules', body: 'Use an isolated memory home.',
        type: 'preference', flagged: 'threat' }],
    });
    await click('Refresh');
    expect(view.textContent).toContain('Held back as possible model instruction.');

    vi.mocked(deleteAgentMemory).mockResolvedValue({ deleted: true, memoryId: 'm1' });
    await click('Delete');
    expect(deleteAgentMemory).toHaveBeenCalledWith('alpha', 'm1');
    expect(view.textContent).not.toContain('Boundary rules');
  });

  it('keeps an editing draft when another entry is deleted', async () => {
    const selected = { id: 'm1', title: 'Selected', body: 'Selected body.', type: 'fact' as const,
      createdAt: 1, updatedAt: 2 };
    const unrelated = { id: 'm2', title: 'Other', body: 'Other body.', type: 'reference' as const,
      createdAt: 3, updatedAt: 4 };
    const overviewWithTwo = { global: [], project: [selected, unrelated], globalFailed: false, projectFailed: false };
    vi.mocked(listAgentMemory).mockResolvedValue(overviewWithTwo);
    vi.mocked(deleteAgentMemory).mockResolvedValue({ deleted: true, memoryId: 'm2' });
    const view = await render();
    await click('Edit');
    const deleteButtons = [...view.querySelectorAll('button')].filter((button) => button.textContent === 'Delete');
    const unrelatedDelete = deleteButtons.at(1);
    if (!unrelatedDelete) throw new Error('missing unrelated delete button');
    await act(async () => { unrelatedDelete.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(deleteAgentMemory).toHaveBeenCalledWith('alpha', 'm2');
    const title = view.querySelector('[aria-label="Edit memory title"]') as HTMLInputElement;
    const body = view.querySelector('[aria-label="Edit memory body"]') as HTMLTextAreaElement;
    expect(title.value).toBe('Selected');
    expect(body.value).toBe('Selected body.');
    expect(view.querySelector('[aria-current="true"]')).toBeTruthy();
  });

  it('refreshes on a valid control event and ignores an invalid payload', async () => {
    const view = await render();
    const initialCalls = vi.mocked(listAgentMemory).mock.calls.length;
    expect(initialCalls).toBeGreaterThan(0);
    await act(async () => {
      emitControlEvent({
        type: AGENT_MEMORY_CHANGED, properties: { scope: 'project', projectId: 'alpha' },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(vi.mocked(listAgentMemory)).toHaveBeenCalledTimes(initialCalls + 1);

    await act(async () => {
      emitControlEvent({ type: AGENT_MEMORY_CHANGED, properties: { scope: 'session' } });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(vi.mocked(listAgentMemory)).toHaveBeenCalledTimes(initialCalls + 1);
  });
});
