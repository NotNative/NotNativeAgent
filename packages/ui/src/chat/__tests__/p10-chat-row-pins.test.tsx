// SPDX-License-Identifier: Apache-0.0
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createDirectoryStore } from '../../sync/child-store.ts';
import { Transcript } from '../transcript.tsx';
import { __resetSessionOrgStoreForTests } from '../../stores/useSessionOrgStore.ts';
import type { SyncEngine } from '../../sync/sync-engine.ts';
import type { Message, Part } from '../../lib/nnd/types.ts';
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
    if (body.op === 'pins.setMessages') record.messagePins = body.pins;
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

it('pins and unpins chat rows through session-org writes', async () => {
  const store = createDirectoryStore();
  setup(store);
  mountTranscript(store);
  const userButton = pinButton('u1');
  const assistantButton = pinButton('a1');
  expect(userButton.getAttribute('aria-pressed')).toBe('true'); // legacy metadata fallback
  expect(assistantButton.getAttribute('aria-pressed')).toBe('false');
  await act(async () => assistantButton.click());
  await act(async () => userButton.click());
  expect(orgPosts.map((post) => post.op)).toEqual(['pins.setMessages', 'pins.setMessages']);
  // First write merges the legacy pin out; the second reads the org record.
  expect((orgRecords['D:/work']?.s1 as { messagePins?: { id: string }[] }).messagePins?.map((pin) => pin.id))
    .toEqual(['a1']);
  expect(userButton.textContent).toBe('Pin message');
  expect(assistantButton.textContent).toBe('Unpin');
});

it('reports an NR chat-row pin failure without a store write', async () => {
  const store = createDirectoryStore();
  setup(store);
  failPost = true;
  mountTranscript(store);
  const button = pinButton('u1');
  await act(async () => button.click());
  expect(orgRecords['D:/work']?.s1).toBeUndefined();
  expect(button.disabled).toBe(false);
  expect(store.getState().session[0]?.metadata).toEqual({ client: { keep: true }, openchamber: {
    context_obligatory_messages: [{ id: 'u1', createdAt: 10, role: 'user' }] } });
});

it('does not emit a chat-row failure toast after unmount', async () => {
  const toast = (await import('sonner')).toast;
  const error = vi.spyOn(toast, 'error');
  const store = createDirectoryStore();
  setup(store);
  failPost = true;
  mountTranscript(store);
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

function mountTranscript(store: ReturnType<typeof createDirectoryStore>): void {
  const engine = { loader: { ensure: async () => undefined, getState: () => ({ status: 'ready' }) } } as unknown as SyncEngine;
  container = document.createElement('div');
  container.setAttribute('data-chat-column', '');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<Transcript store={store} engine={engine} sessionID="s1" directory="D:/work" />));
}

function pinButton(messageID: string): HTMLButtonElement {
  if (!container) throw new Error('Transcript is not mounted');
  const button = container.querySelector(`[data-testid="chat-context-pin-${messageID}"]`);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Pin button ${messageID} is missing`);
  return button;
}
