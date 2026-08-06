// SPDX-License-Identifier: Apache-2.0
import { EditorBuffer } from './tui-model.js';
import { handleEditorAction } from './tui-editor-actions.js';
import { SECRET_KINDS } from './secret-contracts.js';
import { openSecretsManager } from './tui-secret-command.js';

const KINDS = new Set(['secret-kind', 'secret-detail', 'secret-form', 'secret-delete-confirm']);

export function isSecretSetupOverlay(overlay) { return KINDS.has(overlay?.kind); }

export async function beginSecretManagementSelection(selected, workspace, overlay) {
  if (overlay?.kind !== 'secrets' || !selected) return false;
  if (selected.id === 'action:add') {
    workspace.projection.openOverlay(kindOverlay(parentFrom(overlay)));
    return true;
  }
  const secret = (await workspace.listSecrets()).find((item) => item.id === selected.id);
  if (!secret) return false;
  workspace.projection.openOverlay(detailOverlay(secret, parentFrom(overlay)));
  return true;
}

export async function handleSecretSetupAction(action, workspace) {
  const overlay = workspace.projection.overlay;
  if (!isSecretSetupOverlay(overlay)) return false;
  if (overlay.kind === 'secret-form') return handleForm(action, workspace, overlay);
  if (['history_up', 'history_down'].includes(action.action)) {
    workspace.projection.moveOverlaySelection(action.action === 'history_up' ? -1 : 1); return true;
  }
  if (action.action === 'back') { await goBack(workspace, overlay); return true; }
  if (['cancel', 'help'].includes(action.action)) { workspace.projection.closeOverlay(); return true; }
  if (action.action !== 'submit') return true;
  const selected = overlay.items?.[overlay.selected];
  if (!selected) return true;
  if (overlay.kind === 'secret-kind') openForm(workspace, newForm(selected.id, overlay.returnParent));
  else if (overlay.kind === 'secret-detail') await detailAction(selected.id, workspace, overlay);
  else if (overlay.kind === 'secret-delete-confirm') {
    if (selected.id === 'delete') {
      await workspace.deleteSecret(overlay.secret.id);
      await openSecretsManager(workspace, { ...overlay.returnParent, message: `Deleted ${overlay.secret.label}.` });
    } else workspace.projection.openOverlay(detailOverlay(overlay.secret, overlay.returnParent));
  }
  return true;
}

async function detailAction(action, workspace, overlay) {
  const secret = (await workspace.listSecrets()).find((item) => item.id === overlay.secret.id);
  if (!secret) return openSecretsManager(workspace, overlay.returnParent);
  if (action === 'rotate') openForm(workspace, rotateForm(secret, overlay.returnParent));
  else if (action === 'toggle') {
    const updated = await workspace.setSecretEnabled(secret.id, !secret.enabled);
    workspace.projection.openOverlay(detailOverlay(updated, overlay.returnParent, updated.enabled ? 'Secret enabled.' : 'Secret revoked.'));
  } else if (action === 'delete') workspace.projection.openOverlay(deleteOverlay(secret, overlay.returnParent));
}

async function handleForm(action, workspace, overlay) {
  if (action.action === 'back') {
    if (overlay.form.step > 0) openForm(workspace, { ...overlay.form, step: overlay.form.step - 1, error: null });
    else await goBack(workspace, overlay);
    return true;
  }
  if (['cancel', 'help'].includes(action.action)) { workspace.projection.closeOverlay(); return true; }
  if (action.action === 'home') overlay.editor.moveLine('start');
  else if (action.action === 'end') overlay.editor.moveLine('end');
  else if (action.action === 'submit') {
    try { await submitStep(workspace, overlay); }
    catch (error) { workspace.projection.openOverlay(formOverlay({ ...overlay.form, error: error.message }, overlay.editor)); }
    return true;
  } else if (action.action !== 'newline' && handleEditorAction(singleLine(action), overlay.editor)) { /* edited */ }
  else return true;
  workspace.projection.openOverlay(formOverlay(overlay.form, overlay.editor));
  return true;
}

async function submitStep(workspace, overlay) {
  const form = overlay.form;
  const field = form.steps[form.step];
  const value = field.secret ? overlay.editor.text : overlay.editor.text.trim();
  if (!value) throw new Error(`${field.label} cannot be empty.`);
  const draft = { ...form.draft, [field.key]: value };
  if (form.step + 1 < form.steps.length) return openForm(workspace, { ...form, draft, step: form.step + 1, error: null });
  const fields = Object.fromEntries(form.steps.filter((item) => item.secret).map((item) => [item.key, draft[item.key]]));
  const result = form.operation === 'create'
    ? await workspace.createSecret({ label: draft.label, kind: form.kind, fields })
    : await workspace.rotateSecret(form.secret.id, fields);
  await openSecretsManager(workspace, { ...form.returnParent, selectedId: result.id, message: `${form.operation === 'create' ? 'Created' : 'Rotated'} ${result.label}.` });
}

function newForm(kind, returnParent) {
  return { operation: 'create', kind, draft: {}, step: 0, returnParent, steps: [
    field('label', 'Secret label', 'A memorable label. The stored value will never be displayed.', false),
    ...valueSteps(kind),
  ] };
}

function rotateForm(secret, returnParent) {
  return { operation: 'rotate', kind: secret.kind, secret, draft: {}, step: 0, returnParent, steps: valueSteps(secret.kind) };
}

function valueSteps(kind) {
  if (kind === 'username_password') return [
    field('username', 'Username', 'Username supplied only to an approved trusted consumer.', true),
    field('password', 'Password', 'Write-only password. It will be masked while entered.', true),
  ];
  const key = kind === 'api_key' ? 'api_key' : kind === 'token' ? 'token' : 'value';
  return [field(key, kind === 'api_key' ? 'API key' : kind === 'token' ? 'Token' : 'Secret value', 'Write-only value. It will be masked while entered.', true)];
}

function field(key, label, description, secret) { return { key, label, description, secret }; }

function openForm(workspace, form) { workspace.projection.openOverlay(formOverlay(form)); }

function formOverlay(form, editor = new EditorBuffer('', 20_000)) {
  const item = form.steps[form.step];
  const selection = editor.selection();
  const rendered = item.secret ? `${'*'.repeat(Math.min(editor.text.length, 64))}|`
    : `${editor.text.slice(0, selection.start)}|${editor.text.slice(selection.end)}`;
  return Object.freeze({
    kind: 'secret-form', title: form.operation === 'create' ? 'Create secret' : `Rotate secret · ${form.secret.label}`,
    lines: Object.freeze([
      `Step ${form.step + 1} of ${form.steps.length} · ${item.label}`, item.description,
      ...(form.error ? ['', `Cannot continue · ${form.error}`] : []), '', `  ${rendered || '|'}`,
    ]), items: Object.freeze([]), selected: 0, offset: 0, form: Object.freeze(form), editor,
    actionLabel: 'Type value · Enter continue · Esc previous',
  });
}

function kindOverlay(returnParent) {
  return menu('secret-kind', 'Add secret', ['Choose the shape of the credential.'], SECRET_KINDS.map((id) => ({
    id, label: id.replaceAll('_', ' '), detail: id === 'username_password' ? 'Username and password fields' : 'One write-only value',
  })), { returnParent });
}

function detailOverlay(secret, returnParent, message) {
  const lines = [`Label     ${secret.label}`, `Kind      ${secret.kind.replaceAll('_', ' ')}`, `Fields    ${secret.fields.join(', ')}`, `Status    ${secret.enabled ? 'available' : 'revoked'}`];
  if (message) lines.push('', message);
  return menu('secret-detail', `Secret · ${secret.label}`, lines, [
    { id: 'rotate', label: 'Rotate value', detail: 'Replace all write-only fields' },
    { id: 'toggle', label: secret.enabled ? 'Revoke secret' : 'Enable secret', detail: secret.enabled ? 'Prevent future use without deleting it' : 'Allow approved trusted consumers to use it' },
    { id: 'delete', label: 'Delete secret', detail: 'Permanently remove metadata and encrypted fields' },
  ], { secret, returnParent });
}

function deleteOverlay(secret, returnParent) {
  return menu('secret-delete-confirm', 'Delete secret', [`Secret  ${secret.label}`, '', 'This permanently removes its encrypted value.'], [
    { id: 'cancel', label: 'Keep secret', detail: 'Return without changing it' },
    { id: 'delete', label: 'Delete secret', detail: 'Permanently remove this secret' },
  ], { secret, returnParent });
}

async function goBack(workspace, overlay) {
  if (overlay.kind === 'secret-form') {
    if (overlay.form.operation === 'create') workspace.projection.openOverlay(kindOverlay(overlay.form.returnParent));
    else workspace.projection.openOverlay(detailOverlay(overlay.form.secret, overlay.form.returnParent));
  } else if (overlay.kind === 'secret-delete-confirm') workspace.projection.openOverlay(detailOverlay(overlay.secret, overlay.returnParent));
  else await openSecretsManager(workspace, overlay.returnParent ?? {});
}

function menu(kind, title, lines, items, extra = {}) {
  return Object.freeze({ kind, title, lines: Object.freeze(lines), items: Object.freeze(items.map(Object.freeze)), selected: 0, offset: 0, actionLabel: 'Up/Down choose · Enter select · Esc back', ...extra });
}

function singleLine(action) {
  return ['insert', 'paste'].includes(action.action) ? { ...action, text: String(action.text).replaceAll(/[\r\n]+/gu, ' ') } : action;
}

function parentFrom(overlay) { return overlay.parent ? { parent: overlay.parent, configSection: overlay.configSection } : {}; }
