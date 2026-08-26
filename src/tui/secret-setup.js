// SPDX-License-Identifier: Apache-2.0
import { SECRET_KINDS } from '../secret-contracts.js';
import { openSecretsManager } from './secret-command.js';
import { createFormOverlay, formField, handleFormEditing } from './form-engine.js';
import { createConfirmationOverlay, createDetailOverlay, createMenuOverlay } from './surface-engine.js';

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
  if (action === 'rename') openForm(workspace, renameForm(secret, overlay.returnParent));
  else if (action === 'rotate') openForm(workspace, rotateForm(secret, overlay.returnParent));
  else if (action === 'toggle') {
    const updated = await workspace.setSecretEnabled(secret.id, !secret.enabled);
    workspace.projection.openOverlay(detailOverlay(updated, overlay.returnParent, updated.enabled ? 'Secret enabled.' : 'Secret disabled in NNA.'));
  } else if (action === 'delete') {
    if (secret.references?.length) {
      workspace.projection.openOverlay(detailOverlay(secret, overlay.returnParent,
        `Cannot delete · remove ${secret.references.map((item) => item.label).join(', ')} binding first.`));
    } else workspace.projection.openOverlay(deleteOverlay(secret, overlay.returnParent));
  }
}

async function handleForm(action, workspace, overlay) {
  if (action.action === 'back') {
    if (overlay.form.step > 0) openForm(workspace, { ...overlay.form, step: overlay.form.step - 1, error: null });
    else await goBack(workspace, overlay);
    return true;
  }
  if (['cancel', 'help'].includes(action.action)) { workspace.projection.closeOverlay(); return true; }
  if (action.action === 'submit') {
    try { await submitStep(workspace, overlay); }
    catch (error) { workspace.projection.openOverlay(formOverlay({ ...overlay.form, error: error.message }, overlay.editor)); }
    return true;
  } else if (handleFormEditing(action, overlay.editor)) { /* edited */ }
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
    : form.operation === 'rename' ? await workspace.renameSecret(form.secret.id, draft.label)
      : await workspace.rotateSecret(form.secret.id, fields);
  const verb = { create: 'Created', rename: 'Renamed', rotate: 'Replaced' }[form.operation];
  await openSecretsManager(workspace, { ...form.returnParent, selectedId: result.id, message: `${verb} ${result.label}.` });
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

function renameForm(secret, returnParent) {
  return { operation: 'rename', kind: secret.kind, secret, draft: { label: secret.label }, step: 0, returnParent,
    steps: [field('label', 'Secret label', 'Display label only. Provider and MCP bindings continue to use the immutable secret ID.', false)] };
}

function valueSteps(kind) {
  if (kind === 'username_password') return [
    field('username', 'Username', 'Username supplied only to an approved trusted consumer.', true),
    field('password', 'Password', 'Write-only password. It will be masked while entered.', true),
  ];
  const key = kind === 'api_key' ? 'api_key' : kind === 'token' ? 'token' : 'value';
  return [field(key, kind === 'api_key' ? 'API key' : kind === 'token' ? 'Token' : 'Secret value', 'Write-only value. It will be masked while entered.', true)];
}

function field(key, label, description, secret) { return formField(key, label, description, { secret }); }

function openForm(workspace, form) { workspace.projection.openOverlay(formOverlay(form)); }

function formOverlay(form, editor) {
  return createFormOverlay(form, {
    kind: 'secret-form',
    title: (state) => state.operation === 'create' ? 'Create secret'
      : state.operation === 'rename' ? `Rename secret · ${state.secret.label}` : `Replace stored value · ${state.secret.label}`,
  }, editor);
}

function kindOverlay(returnParent) {
  const order = ['api_key', 'token', 'text', 'username_password'].filter((id) => SECRET_KINDS.includes(id));
  return menu('secret-kind', 'Add secret', [
    'Choose the credential type. Every stored value is encrypted and write-only.',
  ], order.map(secretKindItem), { returnParent });
}

function detailOverlay(secret, returnParent, message) {
  const references = secret.references ?? [];
  const lines = [
    `Label     ${secret.label}`, `Kind      ${secretKindLabel(secret.kind)}`,
    `Fields    ${secret.fields.join(', ')}`, `Status    ${secret.enabled ? 'enabled' : 'disabled'}`,
    `Used by   ${references.length > 0 ? references.map((item) => item.label).join(', ') : 'Nothing configured'}`,
  ];
  if (message) lines.push('', message);
  return createDetailOverlay('secret-detail', `Secret · ${secret.label}`, lines, [
    { id: 'rename', label: 'Rename secret', detail: 'Change only the display label; configured consumers remain bound to the secret ID' },
    { id: 'rotate', label: 'Replace stored value', detail: 'Replace all write-only fields; this does not rotate the credential at its issuing service' },
    { id: 'toggle', label: secret.enabled ? 'Disable in NNA' : 'Enable in NNA', detail: secret.enabled ? 'Prevent future NNA use without changing the external credential' : 'Allow approved trusted consumers to use it' },
    { id: 'delete', label: 'Delete from NNA', detail: references.length > 0
      ? 'Unavailable until Provider and MCP bindings are removed'
      : 'Permanently remove local metadata and encrypted fields; the external credential remains active' },
  ], { secret, returnParent });
}

function deleteOverlay(secret, returnParent) {
  return createConfirmationOverlay('secret-delete-confirm', 'Delete secret from NNA', [`Secret  ${secret.label}`, '', 'This permanently removes the locally encrypted value.', 'It does not revoke the credential at its issuing service.'], [
    { id: 'cancel', label: 'Keep secret', detail: 'Return without changing it' },
    { id: 'delete', label: 'Delete secret', detail: 'Permanently remove this secret' },
  ], { secret, returnParent, safeId: 'cancel' });
}

function secretKindItem(id) {
  const values = {
    api_key: { label: 'API key', detail: 'A service-issued key; consumers refer to the field as api_key', section: 'Single value' },
    token: { label: 'Access token', detail: 'A bearer, OAuth, or personal-access token; field name token', section: 'Single value' },
    text: { label: 'Other secret', detail: 'Any other sensitive value; field name value', section: 'Single value' },
    username_password: { label: 'Username and password', detail: 'Separate username and password fields', section: 'Multiple values' },
  };
  return { id, ...values[id] };
}

function secretKindLabel(id) { return secretKindItem(id).label; }

async function goBack(workspace, overlay) {
  if (overlay.kind === 'secret-form') {
    if (overlay.form.operation === 'create') workspace.projection.openOverlay(kindOverlay(overlay.form.returnParent));
    else workspace.projection.openOverlay(detailOverlay(overlay.form.secret, overlay.form.returnParent));
  } else if (overlay.kind === 'secret-delete-confirm') workspace.projection.openOverlay(detailOverlay(overlay.secret, overlay.returnParent));
  else await openSecretsManager(workspace, overlay.returnParent ?? {});
}

function menu(kind, title, lines, items, extra = {}) {
  return createMenuOverlay(kind, title, lines, items, extra);
}

function parentFrom(overlay) { return overlay.parent ? { parent: overlay.parent, configSection: overlay.configSection } : {}; }
