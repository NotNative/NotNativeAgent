// SPDX-License-Identifier: Apache-2.0
import { EditorBuffer } from '../experience/projection.js';
import { ContractError } from '../ids.js';
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
  if (!['insert', 'paste'].includes(action.action) || typeof action.text !== 'string') return action;
  return { ...action, text: action.text.split(/\r?\n/u, 1)[0] };
}

/** Overlay return context. `empty` preserves a caller that historically used
 *  an empty object rather than null for "no parent". */
export function parentFrom(overlay, empty = null) {
  return overlay?.parent ? { parent: overlay.parent, configSection: overlay.configSection } : empty;
}

/** Choose a unique secret label by appending a numeric suffix. */
export async function availableSecretLabel(workspace, base) {
  const labels = new Set((await workspace.listSecrets()).map((secret) => secret.label.toLocaleLowerCase('en-US')));
  if (!labels.has(base.toLocaleLowerCase('en-US'))) return base;
  for (let index = 2; index <= 9_999; index += 1) {
    const candidate = `${base} ${index}`;
    if (!labels.has(candidate.toLocaleLowerCase('en-US'))) return candidate;
  }
  throw new ContractError('secret_label_exhausted', 'Unable to choose a unique credential label.');
}

/** Derive a bounded, URL-safe identifier from a display label. */
export function availableIdentifier(label, existingIds = [], options = {}) {
  const fallback = options.fallback ?? 'item';
  const maxLength = options.maxLength ?? 64;
  const stem = String(label ?? '').normalize('NFKD').replaceAll(/\p{Mark}/gu, '').toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-').replaceAll(/^-+|-+$/gu, '').slice(0, 56) || fallback;
  const existing = new Set(existingIds);
  if (!existing.has(stem)) return stem;
  for (let index = 2; index <= 9_999; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${stem.slice(0, maxLength - suffix.length)}${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new ContractError(options.code ?? 'identifier_exhausted',
    options.message ?? 'Unable to generate a unique identifier.');
}

/** Shared setup-form action loop: back, cancel/help, submit, and editor input.
 *  Domain callers supply the step/back navigators, the submit handler, and the
 *  form overlay builder. */
export async function handleSetupFormAction(action, workspace, overlay, options) {
  if (action.action === 'back') {
    if (overlay.form.stepIndex > 0) options.openStep(workspace, overlay.form, overlay.form.stepIndex - 1);
    else options.goBack(workspace, overlay);
    return true;
  }
  if (['cancel', 'help'].includes(action.action)) {
    workspace.projection.closeOverlay();
    return true;
  }
  if (action.action === 'submit') {
    try { await options.submit(workspace, overlay); }
    catch (error) {
      workspace.projection.openOverlay(options.formOverlay({ ...overlay.form, formError: error.message }, overlay.editor));
    }
    return true;
  }
  if (handleFormEditing(action, overlay.editor)) { /* editor mutated */ }
  else return true;
  workspace.projection.openOverlay(options.formOverlay(overlay.form, overlay.editor));
  return true;
}
