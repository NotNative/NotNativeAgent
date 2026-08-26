// SPDX-License-Identifier: Apache-2.0
import { EditorBuffer } from '../experience/projection.js';
import { handleEditorAction } from './editor-actions.js';

const DEFAULT_FIELD_LIMIT = 4_096;
const DEFAULT_SECRET_LIMIT = 20_000;

export function formEditor(value = '', limit = DEFAULT_FIELD_LIMIT) {
  const editor = new EditorBuffer(limit);
  editor.set(String(value ?? ''));
  return editor;
}

export function createFormOverlay(form, options = {}, existingEditor) {
  const stepIndex = options.stepIndex?.(form) ?? form.stepIndex ?? form.step ?? 0;
  const step = form.steps[stepIndex];
  const limit = options.limit?.(step, form) ?? step.limit
    ?? (step.secret ? DEFAULT_SECRET_LIMIT : DEFAULT_FIELD_LIMIT);
  const initialValue = options.value?.(step, form) ?? form.draft?.[step.key] ?? '';
  const editor = existingEditor ?? formEditor(initialValue, limit);
  const error = options.error?.(form) ?? form.formError ?? form.error;
  const extraLines = options.extraLines?.(form) ?? [];
  return Object.freeze({
    kind: options.kind,
    title: typeof options.title === 'function' ? options.title(form) : options.title,
    lines: Object.freeze([
      `Step ${stepIndex + 1} of ${form.steps.length} · ${step.label}`,
      step.description,
      ...extraLines,
      ...(error ? ['', `Cannot continue · ${error}`] : []),
      '',
      `  ${renderEditor(editor, step.secret)}`,
      ...(step.secret && editor.text.length > 0 ? [`  ${[...editor.text].length} characters entered`] : []),
    ]),
    items: Object.freeze([]), selected: 0, offset: 0,
    actionLabel: options.actionLabel ?? 'Type value · Enter continue · Esc previous',
    form: Object.freeze(form), editor,
  });
}

export function handleFormEditing(action, editor, options = {}) {
  if (action.action === 'home') { editor.moveLine('start'); return true; }
  if (action.action === 'end') { editor.moveLine('end'); return true; }
  if (options.singleLine !== false && action.action === 'newline') return false;
  return handleEditorAction(options.singleLine === false ? action : singleLineAction(action), editor);
}

export function formField(key, label, description, options = {}) {
  return Object.freeze({ key, label, description, ...options });
}

function renderEditor(editor, secret) {
  if (secret) {
    const length = [...editor.text].length;
    return `${'*'.repeat(Math.min(length, 64))}${length > 64 ? '…' : ''}│`;
  }
  const selection = editor.selection();
  const before = editor.text.slice(0, selection.start);
  const selected = editor.text.slice(selection.start, selection.end);
  const after = editor.text.slice(selection.end);
  return `${before}${selected ? `⟦${selected}⟧` : '│'}${after}`;
}

function singleLineAction(action) {
  if (!['insert', 'paste'].includes(action.action)) return action;
  return { ...action, text: String(action.text).split(/\r?\n/u, 1)[0] };
}
