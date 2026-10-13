// SPDX-License-Identifier: Apache-0.0
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseSessionMessagePins, mergeSessionMessagePin, setSessionMessagePinned } from '../context-message-pins.ts';
import { WorkStatusPanel } from '../work-status-panel.tsx';
import { createDirectoryStore } from '../../sync/child-store.ts';
import { __resetSessionOrgStoreForTests, useSessionOrgStore } from '../../stores/useSessionOrgStore.ts';
import type { DirectoryStore } from '../../sync/types.ts';

const orgRecords: Record<string, Record<string, Record<string, unknown>>> = {};
const orgPosts: { sessionID: string; op: string; body: Record<string, unknown> }[] = [];
let failPost = false;

vi.mock('../../lib/runtime-fetch.ts', () => ({
  runtimeFetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes('/api/session-org')) throw new Error(`unexpected fetch ${url}`);
    if ((init?.method ?? 'GET') !== 'POST') {
      const directory = decodeURIComponent(/directory=([^&]*)/u.exec(url)?.[1] ?? '');
      return Response.json({ version: 1, records: orgRecords[directory] ?? {} });
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & {
      directory: string; sessionID: string; op: string };
    orgPosts.push({ sessionID: body.sessionID, op: body.op, body });
    if (failPost) return Response.json({ error: 'write failed' }, { status: 500 });
    const record = orgRecords[body.directory]?.[body.sessionID] ?? {};
    if (body.op === 'pins.setMessages') {
      record.messagePins = body.pins;
    }
    (orgRecords[body.directory] ??= {})[body.sessionID] = record;
    return Response.json({ success: true, record });
  }),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  __resetSessionOrgStoreForTests();
  for (const key of Object.keys(orgRecords)) delete orgRecords[key];
  orgPosts.length = 0;
  failPost = false;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

type PinStore = ReturnType<typeof createDirectoryStore>;

function mount(store: PinStore, sessionID: string): HTMLButtonElement[] {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<WorkStatusPanel store={store} engine={{} as never} embedded expanded sessionID={sessionID} />));
  return [...container.querySelectorAll<HTMLButtonElement>('[aria-pressed]')];
}

describe('session context pins', () => {
  it('drops malformed pin records and preserves the id order', () => {
    expect(parseSessionMessagePins({ openchamber: { context_obligatory_messages: [
      null, { id: 'one', createdAt: 'no', role: 'user' }, { id: 'one', createdAt: 2, role: 'assistant' },
      { id: 'two', createdAt: 1, role: 'user' }] } })).toEqual([
      { id: 'one', createdAt: 2, role: 'assistant' }, { id: 'two', createdAt: 1, role: 'user' }]);
  });

  it('merges pins with a fresh generic metadata patch', () => {
    const merged = mergeSessionMessagePin({ client: { keep: true },
      openchamber: { context_obligatory_messages: [{ id: 'old', createdAt: 5, role: 'assistant' }] } },
      { id: 'm2', role: 'user', time: { created: 20 } }, true);
    expect(parseSessionMessagePins(merged)).toEqual([
      { id: 'old', createdAt: 5, role: 'assistant' }, { id: 'm2', createdAt: 20, role: 'user' }]);
  });

  it('commits the toggle to the org store over the legacy metadata fallback', async () => {
    const committed = await setSessionMessagePinned({
      sessionID: 's1', directory: '/project', pinned: true,
      message: { id: 'm2', role: 'user', time: { created: 20 } },
      metadata: { client: { keep: true }, openchamber: { context_obligatory_messages: [
        { id: 'old', createdAt: 5, role: 'assistant' }] } },
    });
    expect(committed).toBeUndefined();
    expect(orgPosts).toEqual([expect.objectContaining({ sessionID: 's1', op: 'pins.setMessages' })]);
    expect(orgPosts[0]?.body.pins).toEqual([
      { id: 'old', createdAt: 5, role: 'assistant' }, { id: 'm2', createdAt: 20, role: 'user' }]);
    expect(useSessionOrgStore.getState().recordsByDirectory['/project']?.s1?.messagePins).toEqual([
      { id: 'old', createdAt: 5, role: 'assistant' }, { id: 'm2', createdAt: 20, role: 'user' }]);
  });

  it('reports pin count and removes a pin through the org store', async () => {
    const store = createDirectoryStore();
    store.setState({
      session: [{ id: 's1', title: 'Restoring', directory: '/project', time: { created: 1, updated: 2 }, metadata: {
        openchamber: { context_obligatory_messages: [{ id: 'u1', createdAt: 100, role: 'user' }] } } }],
      message: { s1: [
        { id: 'u1', sessionID: 's1', role: 'user', time: { created: 100 } },
        { id: 'a1', sessionID: 's1', role: 'assistant', time: { created: 200, completed: 1_100 } },
      ]},
      part: {},
    } as unknown as Partial<DirectoryStore>);
    const buttons = mount(store, 's1');
    expect(document.querySelector('[data-testid="context-pin-count"]')?.textContent).toBe('1 saved context pin');
    expect(buttons.map((button) => button.textContent)).toEqual(['Pin', 'Unpin']);
    await act(async () => buttons[1]!.click());
    expect(orgPosts.at(-1)?.body.pins).toEqual([]); // the legacy pin is merged out
    // Tombstone semantics: the empty org record wins, so the legacy metadata
    // pin must NOT reappear after the unpin.
    expect(useSessionOrgStore.getState().recordsByDirectory['/project']?.s1?.messagePins).toEqual([]);
    expect(document.querySelector('[data-testid="context-pin-count"]')).toBeNull(); // count row drops with the pin
    expect(document.querySelector('[data-testid="context-pin-error"]')).toBeNull();
  });

  it('keeps concurrent pin writes for the same session serialized in the store', async () => {
    const store = createDirectoryStore();
    store.setState({
      session: [{ id: 's1', directory: '/project', metadata: { other: { keep: true } } } as never],
      message: { s1: [
        { id: 'm1', sessionID: 's1', role: 'user', time: { created: 10 } },
        { id: 'm2', sessionID: 's1', role: 'assistant', time: { created: 20, completed: 30 } },
      ]},
    } as unknown as Partial<DirectoryStore>);
    const buttons = mount(store, 's1');
    await act(async () => {
      buttons[0]!.click();
      buttons[1]!.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const pins = (orgRecords['/project']?.s1 as { messagePins?: { id: string }[] }).messagePins;
    expect(pins?.map((pin) => pin.id).sort()).toEqual(['m1', 'm2']);
  });

  it('does not show an in-flight pin failure for another session', async () => {
    const store = createDirectoryStore();
    failPost = true;
    store.setState({
      session: [
        { id: 's1', directory: '/project', metadata: {} as never },
        { id: 's2', directory: '/project', metadata: {} as never },
      ],
      message: {
        s1: [{ id: 'u1', sessionID: 's1', role: 'user', time: { created: 10 } }],
        s2: [{ id: 'u2', sessionID: 's2', role: 'user', time: { created: 20 } }],
      },
    } as unknown as Partial<DirectoryStore>);
    const buttons = mount(store, 's1');
    await act(async () => {
      buttons[0]!.click();
      await Promise.resolve();
    });
    expect(document.querySelector('[data-testid="context-pin-error"]')?.textContent).toContain('Could not update the context pin');
    act(() => root!.render(<WorkStatusPanel store={store} engine={{} as never} embedded expanded sessionID="s2" />));
    expect(document.querySelector('[data-testid="context-pin-error"]')).toBeNull();
  });
});
