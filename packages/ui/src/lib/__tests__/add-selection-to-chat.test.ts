// SPDX-License-Identifier: Apache-2.0
/**
 * @vitest-environment jsdom
 * §10.5 add-selection-to-chat capture chain + composer handoff events:
 * priority (editor/plan host -> active control -> DOM selection), the
 * composer never capturing itself, language carry, collapse-after-capture.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureSelection, captureToChat } from '../add-selection-to-chat.ts';

afterEach(() => {
  document.body.innerHTML = '';
  window.getSelection()?.removeAllRanges();
});

function focusWithSelection(field: HTMLTextAreaElement | HTMLInputElement, from: number, to: number): void {
  field.focus();
  field.setSelectionRange(from, to);
}

describe('capture chain (§10.5)', () => {
  it('fences a focused editor textarea selection with its language attribute', () => {
    const textarea = document.createElement('textarea');
    textarea.value = 'const x = 1;\nconst y = 2;\n';
    const host = document.createElement('div');
    host.setAttribute('data-editor-host', '');
    host.setAttribute('data-language', 'ts');
    host.appendChild(textarea);
    document.body.appendChild(host);
    focusWithSelection(textarea, 0, 12);
    expect(captureSelection()).toBe('```ts\nconst x = 1;\n```');
  });

  it('fences the plan surface using the textarea\'s own data-language', () => {
    const textarea = document.createElement('textarea');
    textarea.value = '# Plan\nwork\n';
    textarea.setAttribute('data-language', 'markdown');
    const host = document.createElement('div');
    host.setAttribute('data-plan-host', '');
    host.appendChild(textarea);
    document.body.appendChild(host);
    focusWithSelection(textarea, 0, 6);
    expect(captureSelection()).toBe('```markdown\n# Plan\n```');
  });

  it('quotes an input-selection capture and collapses the selection', () => {
    const input = document.createElement('input');
    input.value = 'hello world';
    document.body.appendChild(input);
    focusWithSelection(input, 0, 5);
    expect(captureSelection()).toBe('> hello');
    expect(input.selectionStart).toBe(5);
  });

  it('quotes a DOM selection outside editable surfaces', () => {
    const paragraph = document.createElement('p');
    paragraph.textContent = 'plain text';
    document.body.appendChild(paragraph);
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    selection.removeAllRanges();
    selection.addRange(range);
    expect(captureSelection()).toBe('> plain text');
  });

  it('NEVER captures the composer itself: returns null and keeps its selection', () => {
    const form = document.createElement('form');
    form.setAttribute('data-testid', 'composer');
    const textarea = document.createElement('textarea');
    textarea.value = 'pending draft text';
    form.appendChild(textarea);
    document.body.appendChild(form);
    focusWithSelection(textarea, 0, 7);
    expect(captureSelection()).toBeNull();
    expect(textarea.selectionStart).toBe(0); // selection untouched (no collapse)
  });

  it('captureToChat fires focus ONLY when nothing is selected (no composer self-quote)', () => {
    const form = document.createElement('form');
    form.setAttribute('data-testid', 'composer');
    const textarea = document.createElement('textarea');
    textarea.value = 'pending draft text';
    form.appendChild(textarea);
    document.body.appendChild(form);
    focusWithSelection(textarea, 0, 7);
    const fill = vi.fn();
    const focus = vi.fn();
    window.addEventListener('nnd:composer-fill', fill);
    window.addEventListener('nnd:composer-focus', focus);
    try {
      captureToChat();
      expect(fill).not.toHaveBeenCalled(); // the composer's pending input is never quoted
      expect(focus).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('nnd:composer-fill', fill);
      window.removeEventListener('nnd:composer-focus', focus);
    }
  });

  it('captureToChat fires the composer-fill (+ append flag) + focus events for real captures', () => {
    const input = document.createElement('input');
    input.value = 'hello world';
    document.body.appendChild(input);
    focusWithSelection(input, 0, 5);
    const fill = vi.fn();
    const focus = vi.fn();
    window.addEventListener('nnd:composer-fill', fill);
    window.addEventListener('nnd:composer-focus', focus);
    try {
      captureToChat();
      expect(fill).toHaveBeenCalledTimes(1);
      const event = fill.mock.calls[0]![0] as CustomEvent<{ text: string; append: boolean }>;
      expect(event.detail.text).toBe('> hello');
      expect(event.detail.append).toBe(true); // §10.5: the pending input APPENDS (composer wiring reported, not this module)
      expect(focus).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('nnd:composer-fill', fill);
      window.removeEventListener('nnd:composer-focus', focus);
    }
  });
});
