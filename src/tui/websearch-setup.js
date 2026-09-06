// SPDX-License-Identifier: Apache-2.0
import { createFormOverlay, formEditor, formField, handleFormEditing } from './form-engine.js';
import { webSearchOverlay } from './websearch-overlay.js';
import { createConfirmationOverlay } from './surface-engine.js';

const FORM_KIND = 'websearch-form';
const PROGRESS_KIND = 'websearch-progress';
const REMOVE_KIND = 'websearch-remove-confirm';

export function isWebSearchSetupOverlay(overlay) {
  return [FORM_KIND, PROGRESS_KIND, REMOVE_KIND].includes(overlay?.kind);
}

export async function beginWebSearchManagementSelection(selected, workspace, overlay) {
  if (overlay?.kind !== 'websearch') return false;
  if (selected?.id?.startsWith('remove-profile:')) {
    const status = await workspace.webSearchStatus(false);
    const profileId = selected.id.slice(15);
    const profile = status.config.profiles.find((item) => item.id === profileId);
    if (!profile) return false;
    workspace.projection.openOverlay(removeConfirmation(profile, parentFrom(overlay)));
    return true;
  }
  if (!['action:configure', 'action:add'].includes(selected?.id)) return false;
  const status = await workspace.webSearchStatus(false);
  const primary = status.config?.profiles?.[0];
  const adding = selected.id === 'action:add';
  workspace.projection.openOverlay(profileForm({
    operation: adding ? 'add' : 'configure',
    draft: adding ? { display_name: '', endpoint: '' } : { endpoint: primary?.managed ? '' : primary?.endpoint ?? '' },
    stepIndex: 0, returnParent: parentFrom(overlay), formError: null,
    steps: adding ? [
      formField('display_name', 'Profile name', 'Enter a memorable name for this fallback.', { limit: 128 }),
      endpointField(),
    ] : [endpointField()],
  }));
  return true;
}

export async function handleWebSearchSetupAction(action, workspace) {
  const overlay = workspace.projection.overlay;
  if (!isWebSearchSetupOverlay(overlay)) return false;
  if (overlay.kind === PROGRESS_KIND) return true;
  if (overlay.kind === REMOVE_KIND) return handleRemoveAction(action, workspace, overlay);
  if (action.action === 'back') {
    if (overlay.form.stepIndex > 0) {
      workspace.projection.openOverlay(profileForm({ ...overlay.form, stepIndex: overlay.form.stepIndex - 1, formError: null }));
      return true;
    }
    await openWebSearchManager(workspace, overlay.form.returnParent);
    return true;
  }
  if (['cancel', 'help'].includes(action.action)) {
    workspace.projection.closeOverlay();
    return true;
  }
  if (action.action === 'submit') {
    const step = overlay.form.steps[overlay.form.stepIndex];
    const value = overlay.editor.text.trim();
    if (!value) {
      workspace.projection.openOverlay(profileForm({
        ...overlay.form, formError: `${step.label} cannot be empty.`,
      }, overlay.editor));
      return true;
    }
    const form = { ...overlay.form, draft: { ...overlay.form.draft, [step.key]: value }, formError: null };
    if (form.stepIndex < form.steps.length - 1) {
      workspace.projection.openOverlay(profileForm({ ...form, stepIndex: form.stepIndex + 1 }));
      return true;
    }
    workspace.projection.openOverlay(validationOverlay(form));
    try {
      const result = form.operation === 'add'
        ? await workspace.addWebSearchProfile(form.draft.display_name, form.draft.endpoint)
        : await workspace.configureWebSearch(form.draft.endpoint, false);
      const saved = form.operation === 'add' ? result.config.profiles.at(-1) : result.config.profiles[0];
      await openWebSearchManager(workspace, form.returnParent,
        `${saved.display_name} validated and saved at ${saved.endpoint}.`,
        form.operation === 'add' ? `test:${saved.id}` : 'action:configure');
    } catch (error) {
      workspace.projection.openOverlay(profileForm({ ...form, formError: error.message }, overlay.editor));
    }
    return true;
  }
  if (handleFormEditing(action, overlay.editor)) {
    workspace.projection.openOverlay(profileForm(overlay.form, overlay.editor));
  }
  return true;
}

async function handleRemoveAction(action, workspace, overlay) {
  if (action.action === 'back' || action.action === 'cancel' || action.action === 'help') {
    await openWebSearchManager(workspace, overlay.returnParent);
    return true;
  }
  if (['history_up', 'history_down'].includes(action.action)) {
    workspace.projection.moveOverlaySelection(action.action === 'history_up' ? -1 : 1);
    return true;
  }
  if (action.action !== 'submit') return true;
  const selected = overlay.items[overlay.selected];
  if (selected.id === 'remove') {
    await workspace.deleteWebSearchProfile(overlay.profileId);
    await openWebSearchManager(workspace, overlay.returnParent, `Removed WebSearch profile ${overlay.profileId}.`);
  } else await openWebSearchManager(workspace, overlay.returnParent);
  return true;
}

function profileForm(form, editor) {
  return createFormOverlay(form, {
    kind: FORM_KIND,
    title: form.operation === 'add' ? 'Add WebSearch fallback' : 'Configure primary WebSearch',
    extraLines: () => ['Example: http://192.168.1.50:8080', 'The current configuration remains unchanged unless validation succeeds.'],
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

function endpointField() {
  return formField('endpoint', 'SearXNG endpoint URL',
    'Enter a base URL. NNA will run a bounded JSON search before saving it.', { limit: 2_048 });
}

function removeConfirmation(profile, returnParent) {
  return createConfirmationOverlay(REMOVE_KIND, 'Remove WebSearch profile', [
    `Profile   ${profile.display_name}`, `Endpoint  ${profile.endpoint}`,
    '', 'The next profile becomes primary when you remove the current primary.',
  ], [
    { id: 'cancel', label: 'Keep profile', detail: 'Return without changing WebSearch.' },
    { id: 'remove', label: 'Remove profile', detail: 'Delete this endpoint from the fallback chain.' },
  ], { safeId: 'cancel', profileId: profile.id, returnParent });
}

async function openWebSearchManager(workspace, returnParent, message = null, selectedId = 'action:configure') {
  const view = webSearchOverlay(await workspace.webSearchStatus(false), { message, selectedId });
  workspace.projection.openOverlay(returnParent ? { ...view, ...returnParent } : view);
}

function parentFrom(overlay) {
  return overlay.parent ? { parent: overlay.parent, configSection: overlay.configSection } : null;
}
