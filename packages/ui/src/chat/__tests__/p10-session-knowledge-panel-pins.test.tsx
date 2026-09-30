// SPDX-License-Identifier: Apache-0.0
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../lib/nnd/client.ts', () => ({
  runtimeFetch: vi.fn(),
  normalizeDirectory: (value: string) => value,
  harnessClient: {},
}));
vi.mock('../../lib/session-knowledge-api.ts', () => ({
  getSessionKnowledgeSummary: vi.fn(),
  pinSessionKnowledge: vi.fn(),
  getSessionKnowledge: vi.fn(),
  recordSessionKnowledgeDelivered: vi.fn(),
}));
vi.mock('../../lib/project-context-api.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getProjectContext: vi.fn(),
}));

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getSessionKnowledgeSummary, pinSessionKnowledge } from '../../lib/session-knowledge-api.ts';
import { getProjectContext } from '../../lib/project-context-api.ts';
import { ProjectNotes } from '../project-notes.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const readSummary = vi.mocked(getSessionKnowledgeSummary);
const pinKnowledge = vi.mocked(pinSessionKnowledge);
const readContext = vi.mocked(getProjectContext);
let root: Root | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  readContext.mockResolvedValue({
    notes: [{ id: 'note-1', body: 'Build gate', createdAt: 1, updatedAt: 2 }],
    plans: [{ id: 'plan-1', title: 'Migration', file: 'p.md' }],
    todos: [],
  } as never);
  readSummary.mockResolvedValue({
    notes: [{ id: 'note-1', body: 'Build gate' }],
    plans: [{ id: 'plan-1', title: 'Migration' }],
    memory: { global: 1, project: 1 },
  });
});

afterEach(() => {
  act(() => root?.unmount());
  document.body.textContent = '';
  root = null;
});

function renderSession(sessionId = 'session-1'): void {
  root ??= createRoot(document.body);
  act(() => {
    root?.render(<ProjectNotes directory="D:/project" directoryKey="D:/project" projectId="project-1" visible
      draftLease={null} setDraftLease={() => undefined} draftPinSessionId={sessionId} />);
  });
}

describe('project panel session-knowledge pins', () => {
  it('adopt notes and plans from the additive routes', async () => {
    pinKnowledge.mockResolvedValue({ notes: ['note-1'], plans: ['plan-1'] });
    renderSession();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(pinKnowledge).not.toHaveBeenCalled();
    const note = document.querySelector('[aria-pressed="true"][aria-label="Pin note-1 to the chosen session"]');
    const plan = document.querySelectorAll('[aria-pressed="true"]')[1];
    expect(note).not.toBeNull();
    expect(plan).not.toBeNull();
  });

  it('pins through the route and preserves state after failure', async () => {
    readSummary.mockResolvedValue({
      notes: [],
      plans: [{ id: 'plan-1', title: 'Migration' }],
      memory: { global: 1, project: 1 },
    });
    pinKnowledge.mockResolvedValueOnce({ notes: ['note-1'], plans: [] })
      .mockRejectedValueOnce(new Error('pin rejected'));
    renderSession();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const note = document.querySelector<HTMLButtonElement>('[aria-label="Pin note-1 to the chosen session"]')!;
    await act(async () => note.click());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(pinKnowledge).toHaveBeenCalledWith({
      sessionId: 'session-1', directory: 'D:/project',
      kind: 'note', id: 'note-1', pinned: true,
    });
    const shown = document.querySelector<HTMLButtonElement>('[aria-label="Pin note-1 to the chosen session"]')!;
    expect(shown.getAttribute('aria-pressed')).toBe('true');
    await act(async () => {
      [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Plans')!.click();
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const plan = [...document.querySelectorAll<HTMLButtonElement>('[aria-pressed="false"]')]
      .find((button) => button.textContent === 'Pin')!;
    await act(async () => plan.click());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(pinKnowledge).toHaveBeenLastCalledWith({
      sessionId: 'session-1', directory: 'D:/project',
      kind: 'plan', id: 'plan-1', pinned: true,
    });
    expect(document.body.textContent).toContain('Could not pin the knowledge target');
  });

  it('reports a summary-read failure without clearing project notes', async () => {
    readSummary.mockRejectedValue(new Error('summary offline'));
    renderSession();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(document.body.textContent).toContain('Session-knowledge pin state is unavailable');
    const note = document.querySelector<HTMLButtonElement>('[aria-label="Pin note-1 to the chosen session"]');
    expect(note?.disabled).toBe(true);
    expect(pinKnowledge).not.toHaveBeenCalled();
  });

  it('ignores a pin response after the live session changes', async () => {
    let resolveOldSummary!: (value: unknown) => void;
    const oldSummary = new Promise((resolve) => { resolveOldSummary = resolve; });
    readSummary.mockReturnValueOnce(oldSummary as never).mockResolvedValue({
      notes: [],
      plans: [{ id: 'plan-2', title: 'Next plan' }],
      memory: { global: 1, project: 1 },
    });
    let resolveOldPin!: (value: unknown) => void;
    const oldPin = new Promise((resolve) => { resolveOldPin = resolve; });
    pinKnowledge.mockReturnValueOnce(oldPin as never);
    renderSession('session-1');
    await act(async () => {
      resolveOldSummary({
        notes: [{ id: 'note-1', body: 'Build gate' }],
        plans: [{ id: 'plan-1', title: 'Migration' }],
        memory: { global: 0, project: 0 },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    const note = document.querySelector<HTMLButtonElement>('[aria-label="Pin note-1 to the chosen session"]')!;
    await act(async () => note.click());
    renderSession('session-2');
    await act(async () => {
      resolveOldPin({ notes: ['note-1'], plans: ['plan-1'] });
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => {
      [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Plans')!.click();
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const nextPlan = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Pin');
    expect(nextPlan?.getAttribute('aria-pressed')).toBe('false');
    expect(pinKnowledge).toHaveBeenLastCalledWith({
      sessionId: 'session-1', directory: 'D:/project',
      kind: 'note', id: 'note-1', pinned: false,
    });
  });
});
