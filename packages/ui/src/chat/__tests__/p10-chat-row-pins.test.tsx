// SPDX-License-Identifier: Apache-0.0
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createDirectoryStore } from '../../sync/child-store.ts';
import { Transcript } from '../transcript.tsx';
import { parseSessionMessagePins } from '../context-message-pins.ts';
import type { SyncEngine } from '../../sync/sync-engine.ts';
import type { Message, Part } from '../../lib/nnd/types.ts';
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

it('pins and unpins chat rows through fresh session metadata PATCHes', async () => {
  let metadata: Record<string, unknown> = { client: { keep: true }, openchamber: {
    context_obligatory_messages: [{ id: 'u1', createdAt: 10, role: 'user' }] } };
  const writes: Array<{ path: string; metadata: Record<string, unknown> }> = [];
  const fakeClient = {
    getSession: async () => ({ data: { id: 's1', directory: 'D:/work', metadata } }),
    updateSession: async (sessionID: string, body: { metadata: Record<string, unknown> }) => {
      writes.push({ path: sessionID, metadata: body.metadata });
      metadata = body.metadata;
      return { data: { id: sessionID, directory: 'D:/work', metadata } };
    },
  };
  const store = createDirectoryStore();
  setup(store);
  mountTranscript(fakeClient, store);
  const userButton = pinButton('u1');
  const assistantButton = pinButton('a1');
  expect(userButton.getAttribute('aria-pressed')).toBe('true');
  expect(assistantButton.getAttribute('aria-pressed')).toBe('false');
  await act(async () => assistantButton.click());
  await act(async () => userButton.click());
  expect(writes.map((write) => write.path)).toEqual(['s1', 's1']);
  expect(metadata.client).toEqual({ keep: true });
  expect(parseSessionMessagePins(metadata)).toEqual([
    { id: 'a1', createdAt: 30, role: 'assistant' },
  ]);
  expect(store.getState().session[0]?.metadata).toEqual(metadata);
  expect(userButton.textContent).toBe('Pin message');
  expect(assistantButton.textContent).toBe('Unpin');
});

it('reports an NR chat-row pin failure without changing local metadata', async () => {
  const metadata = {};
  const fakeClient = {
    getSession: async () => ({ data: { id: 's1', directory: 'D:/work', metadata } }),
    updateSession: async () => ({ error: 'write failed' }),
  };
  const store = createDirectoryStore();
  setup(store);
  mountTranscript(fakeClient, store);
  const button = pinButton('u1');
  await act(async () => button.click());
  expect(store.getState().session[0]?.metadata).toEqual({ client: { keep: true }, openchamber: {
    context_obligatory_messages: [{ id: 'u1', createdAt: 10, role: 'user' }] } });
  expect(button.disabled).toBe(false);
});

it('does not emit a chat-row failure toast after unmount', async () => {
  const toast = (await import('sonner')).toast;
  const error = vi.spyOn(toast, 'error');
  const fakeClient = {
    getSession: () => new Promise((resolve) => {
      setTimeout(() => resolve({ error: 'read failed' }), 25);
    }),
    updateSession: async () => ({ error: 'write failed' }),
  };
  const store = createDirectoryStore();
  setup(store);
  mountTranscript(fakeClient, store);
  const button = pinButton('u1');
  act(() => {
    button.click();
    root?.unmount();
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(error).not.toHaveBeenCalled();
  error.mockRestore();
});

function setup(store: ReturnType<typeof createDirectoryStore>): void {
  const user = { id: 'u1', sessionID: 's1', role: 'user', time: { created: 10 } };
  const assistant = { id: 'a1', sessionID: 's1', role: 'assistant', time: { created: 20, completed: 30 },
    providerID: 'p', modelID: 'm', finish: 'stop' };
  const part = (id: string): Part => ({ id: `part-${id}`, sessionID: 's1', messageID: id,
    type: 'text', text: `${id} content` });
  store.setState({
    session: [{ id: 's1', directory: 'D:/work', metadata: { client: { keep: true }, openchamber: {
      context_obligatory_messages: [{ id: 'u1', createdAt: 10, role: 'user' }] } } }] as never,
    message: { s1: [user, assistant] as unknown as Message[] },
    part: { u1: [part('u1')], a1: [part('a1')] },
  } as unknown as Partial<DirectoryStore>);
}

function mountTranscript(pinClient: unknown, store: ReturnType<typeof createDirectoryStore>): void {
  const engine = { loader: { ensure: async () => undefined, getState: () => ({ status: 'ready' }) } } as unknown as SyncEngine;
  container = document.createElement('div');
  container.setAttribute('data-chat-column', '');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<Transcript store={store} engine={engine} sessionID="s1" directory="D:/work"
    pinClient={pinClient as never} />));
}

function pinButton(messageID: string): HTMLButtonElement {
  if (!container) throw new Error('Transcript is not mounted');
  const button = container.querySelector(`[data-testid="chat-context-pin-${messageID}"]`);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing pin button for ${messageID}`);
  return button;
}
