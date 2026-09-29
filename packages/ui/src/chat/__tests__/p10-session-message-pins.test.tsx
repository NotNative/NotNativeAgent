// SPDX-License-Identifier: Apache-0.0
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseSessionMessagePins, mergeSessionMessagePin, setSessionMessagePinned } from '../context-message-pins.ts';
import { WorkStatusPanel } from '../work-status-panel.tsx';
import { createDirectoryStore } from '../../sync/child-store.ts';
import type { DirectoryStore } from '../../sync/types.ts';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('session context pins', () => {
  it('drops malformed pin records and preserves the id order', () => {
    expect(parseSessionMessagePins({ openchamber: { context_obligatory_messages: [
      null, { id: 'one', createdAt: 'no', role: 'user' }, { id: 'one', createdAt: 2, role: 'assistant' },
      { id: 'two', createdAt: 1, role: 'user' }] } })).toEqual([
      { id: 'one', createdAt: 2, role: 'assistant' }, { id: 'two', createdAt: 1, role: 'user' }]);
  });

  it('merges pins with a fresh generic metadata patch', async () => {
    const mutableSession = {
      id: 's1', directory: '/project', metadata: { client: { keep: true },
        openchamber: { context_obligatory_messages: [{ id: 'old', createdAt: 5, role: 'assistant' }] } },
    };
    const patches: unknown[] = [];
    const fakeClient = {
      getSession: async () => ({ data: mutableSession }),
      updateSession: async (sessionID: string, body: Record<string, unknown>) => {
        patches.push({ sessionID, body });
        return { data: { ...mutableSession, ...body } };
      },
    };
    const committed = await setSessionMessagePinned({
      sessionID: 's1', directory: '/project', pinned: true,
      message: { id: 'm2', role: 'user', time: { created: 20 } },
      client: fakeClient as never,
    });
    expect(patches).toEqual([{ sessionID: 's1', body: {
      metadata: { client: { keep: true }, openchamber: { context_obligatory_messages: [
        { id: 'old', createdAt: 5, role: 'assistant' }, { id: 'm2', createdAt: 20, role: 'user' }] } } } }]);
    expect(parseSessionMessagePins(committed?.metadata)).toEqual([
      { id: 'old', createdAt: 5, role: 'assistant' }, { id: 'm2', createdAt: 20, role: 'user' }]);
  });

  it('reports pin count and removes a pin from the work-status ledger', async () => {
    const store = createDirectoryStore();
    let pinCount = 1;
    const fakeClient = {
      getSession: async () => ({ data: { id: 's1', directory: '/project', metadata: { openchamber: {
        context_obligatory_messages: [{ id: 'u1', createdAt: 100, role: 'user' }] } } } }),
      updateSession: async (sessionID: string, body: Record<string, unknown>) => {
        const pins = parseSessionMessagePins((body.metadata as { openchamber?: Record<string, unknown> }).openchamber);
        pinCount = pins.length;
        return { data: { id: sessionID, directory: '/project', metadata: body.metadata } };
      },
    };
    const merged = mergeSessionMessagePin({ existing: true }, { id: 'old', role: 'assistant', time: { created: 5 } }, false);
    expect(parseSessionMessagePins(merged)).toEqual([]);
    store.setState({
      session: [{ id: 's1', title: 'Restoring', directory: '/project', time: { created: 1, updated: 2 }, metadata: {
        openchamber: { context_obligatory_messages: [{ id: 'u1', createdAt: 100, role: 'user' }] } } }],
      message: { s1: [
        { id: 'u1', sessionID: 's1', role: 'user', time: { created: 100 } },
        { id: 'a1', sessionID: 's1', role: 'assistant', time: { created: 200, completed: 1_100 } },
      ]},
      part: {},
    } as unknown as Partial<DirectoryStore>);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(<WorkStatusPanel store={store} engine={{} as never} embedded expanded sessionID="s1" pinClient={fakeClient as never} />));
    expect(document.querySelector('[data-testid="context-pin-count"]')?.textContent).toBe('1 saved context pin');
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('[aria-pressed]')];
    expect(buttons.map((button) => button.textContent)).toEqual(['Pin', 'Unpin']);
    await act(async () => buttons[1]!.click());
    expect(pinCount).toBe(0);
    expect(store.getState().session[0]?.metadata).toEqual({ openchamber: { context_obligatory_messages: [] } });
    expect(document.querySelector('[data-testid="context-pin-error"]')).toBeNull();
  });

  it('keeps concurrent pin writes for the same session', async () => {
    const store = createDirectoryStore();
    let metadata: Record<string, unknown> = { other: { keep: true } };
    const fakeClient = {
      getSession: async () => ({ data: { id: 's1', directory: '/project', metadata } }),
      updateSession: async (_sessionID: string, body: { metadata: Record<string, unknown> }) => {
        metadata = body.metadata;
        return { data: { id: 's1', directory: '/project', metadata } };
      },
    };
    store.setState({
      session: [{ id: 's1', directory: '/project', metadata } as never],
      message: { s1: [
        { id: 'm1', sessionID: 's1', role: 'user', time: { created: 10 } },
        { id: 'm2', sessionID: 's1', role: 'assistant', time: { created: 20, completed: 30 } },
      ]},
    } as unknown as Partial<DirectoryStore>);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(<WorkStatusPanel store={store} engine={{} as never} embedded expanded sessionID="s1" pinClient={fakeClient as never} />));
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('[aria-pressed]')];
    await act(async () => {
      buttons[0]!.click();
      buttons[1]!.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(parseSessionMessagePins(store.getState().session[0]?.metadata)).toEqual([
      { id: 'm2', createdAt: 30, role: 'assistant' },
      { id: 'm1', createdAt: 10, role: 'user' },
    ]);
  });

  it('does not show an in-flight pin failure for another session', async () => {
    const store = createDirectoryStore();
    const fakeClient = {
      getSession: async () => ({ error: 'read failed' }),
      updateSession: async () => ({ error: 'write failed' }),
    };
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
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(<WorkStatusPanel store={store} engine={{} as never} embedded expanded sessionID="s1" pinClient={fakeClient as never} />));
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('[aria-pressed]')];
    await act(async () => {
      buttons[0]!.click();
      await Promise.resolve();
    });
    act(() => root!.render(<WorkStatusPanel store={store} engine={{} as never} embedded expanded sessionID="s2" pinClient={fakeClient as never} />));
    expect(document.querySelector('[data-testid="context-pin-error"]')).toBeNull();
  });
});
