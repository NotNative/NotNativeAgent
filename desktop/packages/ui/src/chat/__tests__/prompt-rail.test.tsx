// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Prompt rail §A.8 (SLICE-C task 5): ≥2-prompt gate, reactive re-render,
 * newest-first dot order with "Current prompt" preview label, hover preview
 * card text, teleport click target.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { PromptNavigatorRail } from '../prompt-rail.tsx';
import type { DirectoryStore } from '../../sync/types.ts';
import type { Message, Part } from '../../lib/nnd/types.ts';

let state = { message: {} as Record<string, Message[]>, part: {} as Record<string, Part[]> };
const listeners = new Set<() => void>();
const store = {
  subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  getState: () => state,
} as unknown as import('zustand/vanilla').StoreApi<DirectoryStore>;

function userMessage(id: string, created: number): Message {
  return { id, sessionID: 's1', role: 'user', time: { created } } as unknown as Message;
}

function textPart(value: string): Part {
  return { type: 'text', text: value } as unknown as Part;
}

function emit(): void {
  for (const listener of listeners) listener();
}

let container: HTMLDivElement | null = null;
let rootHandle: Root | null = null;

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  rootHandle = createRoot(container);
  act(() => {
    rootHandle!.render(<PromptNavigatorRail store={store} sessionID="s1" />);
  });
}

afterEach(() => {
  act(() => { rootHandle?.unmount(); });
  container?.remove();
  container = null;
  rootHandle = null;
  document.body.innerHTML = '';
});

describe('prompt rail §A.8', () => {
  it('hides until ≥2 prompts; newest-first dot order; hover preview flags the current prompt', () => {
    state = { message: { s1: [userMessage('u0', 5)] }, part: { u0: [textPart('solo prompt')] } };
    act(mount);
    expect(document.querySelector('[data-testid="prompt-rail"]')).toBeNull(); // single prompt — hidden

    state = {
      message: { s1: [userMessage('u1', 10), userMessage('u2', 20)] },
      part: { u1: [textPart('first prompt')], u2: [textPart('second prompt deeper')] },
    };
    act(() => { emit(); }); // §A.8 v2: the rail must re-render reactively
    expect(document.querySelectorAll('[data-testid^="prompt-dot-"]')).toHaveLength(2);
    expect(document.querySelector('[data-testid="prompt-dot-0"]')!.getAttribute('aria-label')).toContain('second prompt');

    act(() => {
      document.querySelector('[data-testid="prompt-dot-0"]')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    const preview = document.querySelector('[data-testid="prompt-rail-preview"]')!;
    expect(preview.textContent).toContain('second prompt deeper');
    expect(preview.querySelector('[data-testid="prompt-rail-current-label"]')?.textContent).toBe('Current prompt');
  });

  it('teleport click rewrites the anchor hash for the prompt message', () => {
    state = {
      message: { s1: [userMessage('u1', 10), userMessage('u2', 20)] },
      part: { u1: [textPart('first prompt')], u2: [textPart('second')] },
    };
    act(mount);
    expect(document.querySelectorAll('[data-testid^="prompt-dot-"]')).toHaveLength(2);
    act(() => {
      (document.querySelector('[data-testid="prompt-dot-1"]') as HTMLButtonElement).click();
    });
    expect(window.location.hash).toBe('#message-u1');
  });
});
