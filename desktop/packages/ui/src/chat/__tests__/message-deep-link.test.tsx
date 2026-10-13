// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createDirectoryStore } from '../../sync/child-store.ts';
import { Transcript } from '../transcript.tsx';
import type { SyncEngine } from '../../sync/sync-engine.ts';
import type { Message, Part } from '../../lib/nnd/types.ts';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
const scrolled: Element[] = [];
const realScrollIntoView = Element.prototype.scrollIntoView;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  window.location.hash = '';
  scrolled.length = 0;
  Element.prototype.scrollIntoView = realScrollIntoView;
});

async function mount(store = createDirectoryStore()): Promise<typeof store> {
  container = document.createElement('div');
  container.setAttribute('data-chat-column', '');
  document.body.appendChild(container);
  root = createRoot(container);
  const engine = { loader: { ensure: vi.fn(async () => undefined), getState: () => ({ status: 'ready' }) } } as unknown as SyncEngine;
  await act(async () => root!.render(<Transcript store={store} engine={engine} sessionID="s1" directory="D:/work" />));
  return store;
}

const message = (id: string, created: number): Message => ({ id, sessionID: 's1', role: 'user', time: { created } }) as Message;
const part = (id: string): Part => ({ id: `p-${id}`, sessionID: 's1', messageID: id, type: 'text', text: id }) as Part;

it('navigates a #message-<id> deep link to the anchored row and highlights it', async () => {
  Element.prototype.scrollIntoView = function scrollIntoView(): void { scrolled.push(this); };
  const store = createDirectoryStore({
    message: { s1: [message('older', 1), message('s1:message:2', 2)] },
    part: { older: [part('older')], 's1:message:2': [part('s1:message:2')] },
  });
  window.location.hash = '#message-s1%3Amessage%3A2';
  await mount(store);
  const target = container?.querySelector('[id="message-s1:message:2"]');
  expect(target).not.toBeNull();
  expect(scrolled).toContain(target);
  expect(target?.className).toContain('outline-amber-400/60');
  await vi.waitFor(() => expect(target?.className).not.toContain('outline-amber-400/60'), { timeout: 3000 });
});

it('follows a hashchange to a different message without a reload', async () => {
  Element.prototype.scrollIntoView = function scrollIntoView(): void { scrolled.push(this); };
  const store = createDirectoryStore({
    message: { s1: [message('older', 1), message('newer', 2)] },
    part: { older: [part('older')], newer: [part('newer')] },
  });
  await mount(store);
  expect(scrolled).toHaveLength(0);
  await act(async () => {
    window.location.hash = '#message-newer';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  const target = container?.querySelector('[id="message-newer"]');
  expect(scrolled).toContain(target);
  expect(target?.className).toContain('outline-amber-400/60');
});

it('ignores a deep link whose message is not in the transcript', async () => {
  Element.prototype.scrollIntoView = function scrollIntoView(): void { scrolled.push(this); };
  const store = createDirectoryStore({ message: { s1: [message('older', 1)] }, part: { older: [part('older')] } });
  window.location.hash = '#message-absent';
  await mount(store);
  expect(scrolled).toHaveLength(0);
});
