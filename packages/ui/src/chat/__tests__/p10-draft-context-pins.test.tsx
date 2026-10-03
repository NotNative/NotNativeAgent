// SPDX-License-Identifier: Apache-0.0
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { StoreApi } from 'zustand/vanilla';
import { Composer } from '../composer.tsx';
import { ContextNotes } from '../context-notes.tsx';
import { metadataWithProjectContextPins, parseProjectContextPins } from '../project-context-pins.ts';
import { __resetDraftStoreForTests, readDraft, saveDraft } from '../drafts.ts';
import { useGlobalSyncStore } from '../../sync/global-stores.ts';
import { createSession } from '../../sync/session-lifecycle.ts';
import { createDirectoryStore } from '../../sync/child-store.ts';
import { harnessClient } from '../../lib/nnd/client.ts';
import { runtimeFetch } from '../../lib/runtime-fetch.ts';
import type { Session } from '../../lib/nnd/types.ts';
import { getProjectContext, type ProjectContext } from '../../lib/project-context-api.ts';
import type { DirectoryStore } from '../../sync/types.ts';

vi.mock('../../lib/project-context-api.ts', async (original) => ({
  ...(await original<object>()),
  getProjectContext: vi.fn(),
}));

vi.mock('../../lib/nnd/client.ts', () => ({
  normalizeDirectory: (value: string) => value.replace(/[\\/]+$/u, ''),
  harnessClient: {
    createSession: vi.fn(),
    getSession: vi.fn(),
    updateSession: vi.fn(),
  },
}));
vi.mock('../../lib/runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));

const harnessCreate = vi.mocked(harnessClient.createSession);
const harnessUpdate = vi.mocked(harnessClient.updateSession);
const harnessGet = vi.mocked(harnessClient.getSession);

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
const emptyContext: ProjectContext = { version: 2, notes: [], todos: [], plans: [] };
const baseStore = { command: [], agent: [], provider: [], config: {}, message: {}, part: {}, permission: {}, question: {} };
const store = { subscribe: () => () => undefined, getState: () => baseStore } as unknown as StoreApi<DirectoryStore>;
const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;

beforeEach(() => {
  __resetDraftStoreForTests();
  useGlobalSyncStore.getState().reset();
  document.body.innerHTML = '';
  vi.mocked(getProjectContext).mockReset().mockResolvedValue(emptyContext);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('draft project-context pins', () => {
  it('parses malformed pins and carries an empty set as no metadata change', () => {
    expect(parseProjectContextPins({ project_context_pins: {
      notes: [null, 'same', 'same', 5], plans: ['plan'] } })).toEqual({
      notes: ['same'], plans: ['plan'] });
    expect(parseProjectContextPins(null)).toEqual({ notes: [], plans: [] });
    expect(metadataWithProjectContextPins({ existing: true }, { notes: [], plans: [] })).toBeNull();
  });

  it('merges draft pins into fresh metadata and preserves sibling namespaces', () => {
    const metadata = metadataWithProjectContextPins({ nnd: { configuredModel: 'x' } }, {
      notes: ['note-1'], plans: ['plan-1'] });
    expect(metadata).toEqual({ nnd: { configuredModel: 'x' }, openchamber: {
      project_context_pins: { notes: ['note-1'], plans: ['plan-1'] } } });
  });

  it('sends draft pins with the materializing session and clears them after delivery', async () => {
    const send = vi.fn(async () => undefined);
    const createSessionAction = vi.fn(async (input: { projectContextPins?: { notes: string[]; plans: string[] } }) => {
      expect(input.projectContextPins).toEqual({ notes: ['note-1'], plans: ['plan-1'] });
      return { id: 'session_1', metadata: { nnd: { configuredModel: { providerID: 'primary', modelID: 'test' } } } };
    });
    saveDraft('/proj', 'draft', { text: '', attachments: [], queue: [],
      projectContextPins: { notes: ['note-1'], plans: ['plan-1'] } });
    await renderComposer({ send, createSessionAction });
    await typeAndSubmit('start here');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ sessionID: 'session_1' }));
    expect(readDraft('/proj', 'draft').projectContextPins).toEqual({ notes: [], plans: [] });
  });

  it('keeps draft pins when the materializing session cannot be created', async () => {
    const send = vi.fn(async () => undefined);
    const createSessionAction = vi.fn(async () => { throw new Error('offline'); });
    saveDraft('/proj', 'draft', { text: '', attachments: [], queue: [],
      projectContextPins: { notes: ['note-1'], plans: [] } });
    await renderComposer({ send, createSessionAction });
    await typeAndSubmit('retry');
    expect(createSessionAction).toHaveBeenCalledWith(expect.objectContaining({
      projectContextPins: { notes: ['note-1'], plans: [] } }));
    expect(send).not.toHaveBeenCalled();
    expect(readDraft('/proj', 'draft').projectContextPins).toEqual({ notes: ['note-1'], plans: [] });
  });

  it('lets a draft-target note panel update its pin set without clearing the note body', async () => {
    const note = { id: 'note-1', body: 'Draft pin note', createdAt: 1, updatedAt: 1, source: 'manual' as const };
    vi.mocked(getProjectContext).mockResolvedValue({ ...emptyContext, notes: [note] });
    saveDraft('/proj', 'draft', { text: 'Keep this draft', attachments: [], queue: [] });
    await act(async () => {
      root!.render(<ContextNotes projectId="p1" visible draftPins={{ notes: [], plans: [] }}
        onToggleNotePin={(noteID, pinned) => {
          const record = readDraft('/proj', 'draft');
          saveDraft('/proj', 'draft', {
            ...record,
            projectContextPins: pinned
              ? { ...record.projectContextPins, notes: [...record.projectContextPins.notes, noteID] }
              : { ...record.projectContextPins, notes: record.projectContextPins.notes.filter((id) => id !== noteID) },
          });
        }} />);
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const pin = document.querySelector('[aria-label="Pin note-1 to the new-session draft"]') as HTMLButtonElement;
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    await act(async () => pin.click());
    expect(readDraft('/proj', 'draft').projectContextPins).toEqual({ notes: ['note-1'], plans: [] });
  });
});

describe('fresh-session pin transfer', () => {
  it('patches created-session metadata before the action returns', async () => {
    const created = { id: 'fresh', directory: '/work', metadata: { nnd: { route: 'x' } } };
    const merged = { nnd: { route: 'x' }, openchamber: {
      project_context_pins: { notes: ['note-1'], plans: ['plan-1'] } } };
    const storeForCreate = createDirectoryStore();
    harnessCreate.mockResolvedValue({ data: created as unknown as Session });
    vi.mocked(runtimeFetch).mockResolvedValue(new Response(JSON.stringify({ directory: '/work' })));
    harnessGet.mockResolvedValue({ data: created as unknown as Session });
    harnessUpdate.mockResolvedValue({ data: { ...created, metadata: merged } as unknown as Session });
    const engine = {
      ensureChild: () => storeForCreate,
      registerSessionRoute: () => undefined,
      loaderInitializeCreated: () => undefined,
      onSelectSession: () => undefined,
    };
    const session = await createSession(engine as never, { directory: '/work',
      projectContextPins: { notes: ['note-1'], plans: ['plan-1'] } });
    expect(harnessUpdate).toHaveBeenCalledWith('fresh', { metadata: merged }, { directory: '/work' });
    expect(session.metadata).toEqual(merged);
    expect(storeForCreate.getState().session[0]?.metadata).toEqual(merged);
  });
});

async function renderComposer(actions: {
  send: (input: unknown) => Promise<void>;
  createSessionAction: (input: { projectContextPins?: { notes: string[]; plans: string[] } }) => Promise<{ id: string; metadata?: unknown }>;
}): Promise<void> {
  await act(async () => {
    root!.render(<Composer services={{ engine: { actions: { send: actions.send,
      createSession: actions.createSessionAction } } as never, store: () => store, dispatch: () => undefined }}
      sessionID={null} directory="/proj" sessionKey="draft" />);
    await Promise.resolve();
  });
}

async function typeAndSubmit(text: string): Promise<void> {
  const editor = document.querySelector('[data-testid="composer-editor"]') as HTMLTextAreaElement;
  await act(async () => {
    nativeSet.call(editor, text);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
  await act(async () => {
    (document.querySelector('[data-testid="composer"]') as HTMLFormElement)
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}
