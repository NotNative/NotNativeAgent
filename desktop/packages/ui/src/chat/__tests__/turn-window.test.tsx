// SPDX-License-Identifier: Apache-2.0
/** Turn-window virtualization (W-27.virtualization): helpers + DOM behavior. */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TURN_WINDOW, hiddenTurnCount, turnHoldsMessage, windowStartIndex } from '../turn-window.ts';
import { Transcript } from '../transcript.tsx';
import { createDirectoryStore } from '../../sync/child-store.ts';
import type { Message, Part } from '../../lib/nnd/types.ts';
import type { SyncEngine } from '../../sync/sync-engine.ts';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('turn window helpers', () => {
  it('keeps the newest TURN_WINDOW turns and expands on demand', () => {
    expect(windowStartIndex(30, 0)).toBe(0);
    expect(windowStartIndex(60, 0)).toBe(20);
    expect(windowStartIndex(60, 25)).toBe(0);
    expect(hiddenTurnCount(60, 0)).toBe(20);
    expect(hiddenTurnCount(30, 0)).toBe(0);
  });

  it('a turn holds its prompt or any assistant reply id', () => {
    const turn = { userMessage: { id: 'u1' }, assistant: [{ id: 'a1' }, { id: 'a2' }] };
    expect(turnHoldsMessage(turn, 'u1')).toBe(true);
    expect(turnHoldsMessage(turn, 'a2')).toBe(true);
    expect(turnHoldsMessage(turn, 'zz')).toBe(false);
  });
});

describe('windowed transcript rendering (W-27.virtualization)', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    container = null;
    root = null;
    window.history.replaceState(null, '', window.location.pathname);
  });

  function mount(count: number): { node: HTMLDivElement; store: ReturnType<typeof createDirectoryStore> } {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const messages: Message[] = [];
    const parts: Record<string, Part[]> = {};
    for (let at = 0; at < count; at += 1) {
      const id = `u${String(at).padStart(2, '0')}`;
      messages.push({ id, sessionID: 's1', role: 'user', time: { created: at + 1 } } as Message);
      parts[id] = [{ id: `p${id}`, sessionID: 's1', messageID: id, type: 'text', text: `prompt ${at}` } as Part];
    }
    const store = createDirectoryStore({ message: { s1: messages }, part: parts, session: [], permission: {}, question: {} } as never);
    act(() => root!.render(<Transcript store={store} engine={{ loader: { ensure: async () => undefined, getState: () => ({ status: 'idle', cursor: null, complete: true }) } } as unknown as SyncEngine}
      sessionID="s1" directory="D:/work" />));
    return { node: container!, store };
  }

  it('renders only the newest window with an expander; expanding reveals the rest', () => {
    const count = TURN_WINDOW + 5;
    const { node } = mount(count);
    expect(node.querySelector('[data-testid="show-older-turns"]')?.textContent).toContain(`Show ${count - TURN_WINDOW} older turns`);
    expect(node.textContent).not.toContain('prompt 0'); // oldest turn hidden
    expect(node.textContent).toContain('prompt 44'); // newest turn visible
    act(() => (node.querySelector('[data-testid="show-older-turns"]') as HTMLButtonElement).click());
    expect(node.textContent).toContain('prompt 0');
    expect(node.querySelector('[data-testid="show-older-turns"]')).toBeNull();
  });

  it('a deep link to a hidden turn expands the window and highlights the anchor', async () => {
    Element.prototype.scrollIntoView = function scrollIntoView(): void { /* jsdom stub */ };
    const count = TURN_WINDOW + 3;
    const { node } = mount(count);
    expect(node.querySelector('[data-testid="chat-context-pin-u00"]')).toBeNull();
    window.history.replaceState(null, '', '#message-u00');
    act(() => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
    await act(async () => { await Promise.resolve(); });
    await vi.waitFor(() => {
      const anchor = node.querySelector('[id="message-u00"]');
      expect(anchor).toBeTruthy();
      expect(anchor!.className).toContain('outline-amber-400/60');
    });
  });
});
