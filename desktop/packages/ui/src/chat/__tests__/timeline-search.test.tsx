// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createDirectoryStore } from '../../sync/child-store.ts';
import { TimelineDialog } from '../timeline-dialog.tsx';
import type { SyncEngine } from '../../sync/sync-engine.ts';
import type { Message, Part } from '../../lib/nnd/types.ts';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  window.history.replaceState(null, '', window.location.pathname);
  vi.restoreAllMocks();
});

function user(id: string, at: number, text: string): Message {
  return { id, sessionID: 's1', role: 'user', time: { created: at } } as Message;
}
function text(id: string, messageID: string, body: string): Part {
  return { id, sessionID: 's1', messageID, type: 'text', text: body } as Part;
}

function mount(onClose: () => void): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const store = createDirectoryStore({
    message: {
      s1: [
        user('u1', 1, 'first prompt about login'),
        user('u2', 2, 'second prompt about exports'),
        user('u3', 3, 'third prompt about themes'),
      ],
    },
    part: {
      u1: [text('p1', 'u1', 'first prompt about login')],
      u2: [text('p2', 'u2', 'second prompt about exports')],
      u3: [text('p3', 'u3', 'third prompt about themes')],
    },
  });
  act(() => root!.render(<TimelineDialog store={store} engine={{} as SyncEngine} sessionID="s1" onClose={onClose} />));
  return container;
}

function rows(node: HTMLDivElement): HTMLElement[] {
  return [...node.querySelectorAll<HTMLElement>('[data-testid="timeline-row"] button.min-w-0')];
}

it('timeline search filters prompt rows case-insensitively and shows the empty state', () => {
  const node = mount(() => undefined);
  expect(rows(node)).toHaveLength(3);
  const input = node.querySelector('[data-testid="timeline-search"]') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => { setter.call(input, 'EXPORTS'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  const filtered = rows(node);
  expect(filtered).toHaveLength(1);
  expect(filtered[0]!.textContent).toContain('second prompt about exports');
  act(() => { setter.call(input, 'nothing matches this'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(rows(node)).toHaveLength(0);
  expect(node.textContent).toContain('No messages found');
  act(() => { setter.call(input, '  '); input.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(rows(node)).toHaveLength(3);
});

it('prompt navigation: clicking a row closes and deep-links; the previous-turn arrow jumps without closing', () => {
  const onClose = vi.fn();
  const node = mount(onClose);
  act(() => { rows(node)[2]!.click(); }); // rows are newest-first: index 2 = oldest
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(window.location.hash).toBe('#message-u1');
  window.history.replaceState(null, '', window.location.pathname);
  onClose.mockClear();

  const arrows = [...node.querySelectorAll('[aria-label="Previous turn"]')];
  expect(arrows).toHaveLength(2); // every row except the oldest
  act(() => { (arrows[0] as HTMLButtonElement).click(); });
  expect(onClose).not.toHaveBeenCalled();
  expect(window.location.hash).toBe('#message-u2'); // newest row steps to its previous turn
  act(() => { (arrows[1] as HTMLButtonElement).click(); });
  expect(window.location.hash).toBe('#message-u1');
});
