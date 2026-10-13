// SPDX-License-Identifier: Apache-2.0
/**
 * Add selection to chat (doc 06 10.5): trigger `mod+l` through the
 * shortcut registry; capture priority: focused CodeMirror selection
 * (textarea-host v1: focused textarea/input with a shell-selection)
 * -> active text control -> DOM selection. The chat COMPOSER never captures
 * (its own pending input is quoted nowhere; mod+l over it just focuses).
 * Captures append to the composer pending input and focus it; with nothing
 * selected just focuses. Handoff rides the `nnd:composer-fill` channel
 * (P3b) — callers pass detail { text, append: true }; §B.9 revert/chips use
 * their own replace semantics (reported, not this module's scope).
 */

const FILL_EVENT = 'nnd:composer-fill';
const FOCUS_EVENT = 'nnd:composer-focus';
const EDITOR_SELECTOR = '[data-editor-host]';
const COMPOSER_SELECTOR = '[data-testid="composer"]';

function isEditable(target: EventTarget | null): target is HTMLTextAreaElement | HTMLInputElement {
  return target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement;
}

/** 10.5 capture chain. Returns the captured markdown or null (just focus). */
export function captureSelection(): string | null {
  const active = document.activeElement;
  if (active instanceof HTMLElement) {
    const composer = document.querySelector(COMPOSER_SELECTOR);
    if (composer !== null && composer.contains(active)) return null; // never quote the composer itself (§10.5 non-composer)
  }
  if (active instanceof HTMLElement && active.matches(`.cm-editor.cm-focused, ${EDITOR_SELECTOR} textarea, [data-plan-host] textarea`)) {
    const field = isEditable(active) ? active : (active.querySelector('textarea'));
    if (field !== null && field.selectionStart !== null && field.selectionEnd !== null && field.selectionStart < field.selectionEnd) {
      const language = field.getAttribute('data-language') ?? field.closest('[data-language]')?.getAttribute('data-language') ?? '';
      return fenced(field.value.slice(field.selectionStart, field.selectionEnd), language);
    }
  }
  if (isEditable(active) && active.selectionStart !== null && active.selectionEnd !== null && active.selectionStart < active.selectionEnd) {
    const text = active.value.slice(active.selectionStart, active.selectionEnd);
    active.setSelectionRange(active.selectionEnd, active.selectionEnd); // collapsed after capture
    return quoted(text);
  }
  const selection = window.getSelection();
  if (selection !== null && selection.rangeCount > 0 && !selection.isCollapsed) {
    return rangeToMarkdown(selection);
  }
  return null;
}

function fenced(text: string, language: string): string {
  return `\`\`\`${language}\n${text}\n\`\`\``;
}

function quoted(text: string): string {
  return text.split('\n').map((row) => `> ${row}`).join('\n');
}

function rangeToMarkdown(selection: Selection): string {
  return quoted(selection.toString());
}

export function captureToChat(): void {
  const captured = captureSelection();
  if (captured !== null) {
    window.dispatchEvent(new CustomEvent(FILL_EVENT, { detail: { text: captured, append: true } }));
  }
  window.dispatchEvent(new CustomEvent(FOCUS_EVENT));
}
