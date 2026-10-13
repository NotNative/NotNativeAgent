// SPDX-License-Identifier: Apache-0.0
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../lib/session-knowledge-api.ts', () => ({
  getSessionKnowledgeSummary: vi.fn(),
  pinSessionKnowledge: vi.fn(),
  getSessionKnowledge: vi.fn(),
  recordSessionKnowledgeDelivered: vi.fn(),
}));

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { StoreApi } from 'zustand/vanilla';
import { getSessionKnowledgeSummary, pinSessionKnowledge } from '../../lib/session-knowledge-api.ts';
import { WorkStatusPanel } from '../work-status-panel.tsx';
import { createDirectoryStore } from '../../sync/child-store.ts';
import type { DirectoryStore } from '../../sync/types.ts';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const readSummary = vi.mocked(getSessionKnowledgeSummary);
const pinKnowledge = vi.mocked(pinSessionKnowledge);
let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function render(store: StoreApi<DirectoryStore>, sessionID = 's1'): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<WorkStatusPanel store={store} engine={{} as never} embedded expanded sessionID={sessionID} />));
}

describe('work-status session knowledge sources', () => {
  it('displays pinned summaries and locally invalidates an unpinned target', async () => {
    readSummary.mockResolvedValue({
      notes: [{ id: 'note-1', body: 'Database gate' }, { id: 'note-2', body: 'Release rule' }],
      plans: [{ id: 'plan-1', title: 'Migration plan' }],
      memory: { global: 3, project: 2 },
    });
    pinKnowledge.mockResolvedValue({ notes: ['note-2'], plans: ['plan-1'] });
    const store = createDirectoryStore();
    store.setState({
      session: [{ id: 's1', directory: '/project', metadata: {} as never }],
    } as unknown as Partial<DirectoryStore>);
    render(store);
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelector('[data-testid="ws-knowledge-note-note-1"]')?.textContent)
      .toContain('Database gate');
    expect(document.querySelector('[data-testid="ws-knowledge-plan-plan-1"]')?.textContent)
      .toContain('Migration plan');
    expect(document.body.textContent).toContain('3 global · 2 project');
    const unpin = document.querySelectorAll<HTMLButtonElement>('button');
    const noteButton = [...unpin].find((button) => button.textContent === 'Unpin')!;
    await act(async () => noteButton.click());
    expect(pinKnowledge).toHaveBeenCalledWith({
      sessionId: 's1', directory: '/project', kind: 'note', id: 'note-1', pinned: false,
    });
    expect(document.querySelector('[data-testid="ws-knowledge-note-note-1"]')).toBeNull();
    expect(document.querySelector('[data-testid="ws-knowledge-note-note-2"]')).not.toBeNull();
  });

  it('renders an unavailable state without breaking other sections', async () => {
    readSummary.mockRejectedValue(new Error('summary offline'));
    const store = createDirectoryStore();
    store.setState({
      session: [{ id: 's1', directory: '/project', title: 'Working', metadata: {} as never }],
    } as unknown as Partial<DirectoryStore>);
    render(store);
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelector('[data-testid="ws-knowledge-sources"]')?.textContent)
      .toContain('KnowledgeUnavailable');
    expect(document.querySelector('[data-testid="context-session-header"]')).not.toBeNull();
  });
});
