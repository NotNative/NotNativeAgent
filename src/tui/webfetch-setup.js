// SPDX-License-Identifier: Apache-2.0
import { createFormOverlay, formEditor, formField, handleFormEditing } from './form-engine.js';
import { webFetchOverlay } from './overlays.js';

const FORM_KIND = 'webfetch-form';
const PROGRESS_KIND = 'webfetch-progress';

export function isWebFetchSetupOverlay(overlay) {
  return [FORM_KIND, PROGRESS_KIND].includes(overlay?.kind);
}

export function beginWebFetchManagementSelection(selected, workspace, overlay) {
  if (overlay?.kind !== 'webfetch' || !selected?.id) return false;
  const action = selected.id === 'action:trust' ? 'trust'
    : selected.id === 'action:revoke' || !selected.id.startsWith('action:') ? 'revoke' : null;
  if (!action) return false;
  const origin = selected.id.startsWith('action:') ? '' : selected.id;
  workspace.projection.openOverlay(originForm({
    action, draft: { origin }, stepIndex: 0, returnParent: parentFrom(overlay), formError: null,
    steps: [formField('origin', 'Exact HTTP(S) origin', action === 'trust'
      ? 'Enter one credential-free origin to trust for bounded WebFetch requests.'
      : 'Enter the exact trusted origin to revoke.', { limit: 2_048 })],
  }));
  return true;
}

export async function handleWebFetchSetupAction(action, workspace) {
  const overlay = workspace.projection.overlay;
  if (!isWebFetchSetupOverlay(overlay)) return false;
  if (overlay.kind === PROGRESS_KIND) return true;
  if (action.action === 'back') {
    await openWebFetchManager(workspace, overlay.form.returnParent);
    return true;
  }
  if (['cancel', 'help'].includes(action.action)) {
    workspace.projection.closeOverlay();
    return true;
  }
  if (action.action === 'submit') {
    const origin = overlay.editor.text.trim();
    if (!origin) {
      workspace.projection.openOverlay(originForm({ ...overlay.form, formError: 'Exact origin cannot be empty.' }, overlay.editor));
      return true;
    }
    const form = { ...overlay.form, draft: { origin }, formError: null };
    workspace.projection.openOverlay(progressOverlay(form));
    try {
      await workspace.webFetchCommand([form.action, origin]);
      await openWebFetchManager(workspace, form.returnParent,
        form.action === 'trust' ? `Trusted ${origin}.` : `Revoked ${origin}.`,
        form.action === 'trust' ? origin : 'action:trust');
    } catch (error) {
      workspace.projection.openOverlay(originForm({ ...form, formError: error.message }, overlay.editor));
    }
    return true;
  }
  if (handleFormEditing(action, overlay.editor)) {
    workspace.projection.openOverlay(originForm(overlay.form, overlay.editor));
  }
  return true;
}

function originForm(form, editor) {
  return createFormOverlay(form, {
    kind: FORM_KIND,
    title: form.action === 'trust' ? 'Trust WebFetch destination' : 'Revoke WebFetch destination',
    extraLines: () => [
      'Example: http://192.168.1.50:8080',
      'Use only the origin: scheme, host, and optional port. Paths, credentials, queries, and fragments are rejected.',
    ],
    actionLabel: `Type exact origin · Enter ${form.action} · Esc back`,
  }, editor);
}

function progressOverlay(form) {
  const verb = form.action === 'trust' ? 'Trusting' : 'Revoking';
  return Object.freeze({
    kind: PROGRESS_KIND, title: `${verb} WebFetch destination`,
    lines: Object.freeze([`${verb} ${form.draft.origin}…`]),
    items: Object.freeze([]), selected: 0, offset: 0, navigation: 'progress',
    form: Object.freeze(form), editor: formEditor('', 2_048),
  });
}

async function openWebFetchManager(workspace, returnParent, message = null, selectedId = 'action:trust') {
  const result = await workspace.webFetchCommand(['status']);
  const view = webFetchOverlay(result.config, { message, selectedId });
  workspace.projection.openOverlay(returnParent ? { ...view, ...returnParent } : view);
}

function parentFrom(overlay) {
  return overlay.parent ? { parent: overlay.parent, configSection: overlay.configSection } : null;
}
