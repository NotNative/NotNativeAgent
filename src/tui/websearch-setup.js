// SPDX-License-Identifier: Apache-2.0
import { createFormOverlay, formEditor, formField, handleFormEditing } from './form-engine.js';
import { webSearchOverlay } from './overlays.js';

const FORM_KIND = 'websearch-form';
const PROGRESS_KIND = 'websearch-progress';

export function isWebSearchSetupOverlay(overlay) {
  return [FORM_KIND, PROGRESS_KIND].includes(overlay?.kind);
}

export async function beginWebSearchManagementSelection(selected, workspace, overlay) {
  if (overlay?.kind !== 'websearch' || selected?.id !== 'action:configure') return false;
  const status = await workspace.webSearchStatus(false);
  const endpoint = status.config?.managed ? '' : status.config?.endpoint ?? '';
  workspace.projection.openOverlay(endpointForm({
    draft: { endpoint }, stepIndex: 0, returnParent: parentFrom(overlay), formError: null,
    steps: [formField('endpoint', 'SearXNG endpoint URL',
      'Enter the base URL of an existing SearXNG service. NNA will run a bounded JSON search to validate it before saving.',
      { limit: 2_048 })],
  }));
  return true;
}

export async function handleWebSearchSetupAction(action, workspace) {
  const overlay = workspace.projection.overlay;
  if (!isWebSearchSetupOverlay(overlay)) return false;
  if (overlay.kind === PROGRESS_KIND) return true;
  if (action.action === 'back') {
    await openWebSearchManager(workspace, overlay.form.returnParent);
    return true;
  }
  if (['cancel', 'help'].includes(action.action)) {
    workspace.projection.closeOverlay();
    return true;
  }
  if (action.action === 'submit') {
    const endpoint = overlay.editor.text.trim();
    if (!endpoint) {
      workspace.projection.openOverlay(endpointForm({ ...overlay.form, formError: 'Endpoint URL cannot be empty.' }, overlay.editor));
      return true;
    }
    const form = { ...overlay.form, draft: { endpoint }, formError: null };
    workspace.projection.openOverlay(validationOverlay(form));
    try {
      const result = await workspace.configureWebSearch(endpoint, false);
      await openWebSearchManager(workspace, form.returnParent,
        `Endpoint validated and WebSearch enabled at ${result.config.endpoint}.`, 'action:configure');
    } catch (error) {
      workspace.projection.openOverlay(endpointForm({ ...form, formError: error.message }, overlay.editor));
    }
    return true;
  }
  if (handleFormEditing(action, overlay.editor)) {
    workspace.projection.openOverlay(endpointForm(overlay.form, overlay.editor));
  }
  return true;
}

function endpointForm(form, editor) {
  return createFormOverlay(form, {
    kind: FORM_KIND,
    title: 'Configure WebSearch',
    extraLines: () => ['Example: http://192.168.1.50:8080', 'The current configuration remains unchanged unless validation succeeds.'],
    actionLabel: 'Type endpoint URL · Enter validate · Esc back',
  }, editor);
}

function validationOverlay(form) {
  return Object.freeze({
    kind: PROGRESS_KIND,
    title: 'Validating WebSearch endpoint',
    lines: Object.freeze([`Connecting to ${form.draft.endpoint}`, '', 'Running a bounded SearXNG JSON search…']),
    items: Object.freeze([]), selected: 0, offset: 0, navigation: 'progress',
    form: Object.freeze(form), editor: formEditor('', 2_048),
  });
}

async function openWebSearchManager(workspace, returnParent, message = null, selectedId = 'action:configure') {
  const view = webSearchOverlay(await workspace.webSearchStatus(false), { message, selectedId });
  workspace.projection.openOverlay(returnParent ? { ...view, ...returnParent } : view);
}

function parentFrom(overlay) {
  return overlay.parent ? { parent: overlay.parent, configSection: overlay.configSection } : null;
}
