// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { providerOverlay, valueOverlay } from './overlays.js';
import { DEFAULT_MODEL_OUTPUT_TOKENS } from '../reliability/output-headroom.js';
import { createFormOverlay, formEditor, formField, handleFormEditing } from './form-engine.js';
import { createConfirmationOverlay, createMenuOverlay } from './surface-engine.js';

const SETUP_KINDS = new Set([
  'provider-preset', 'provider-profile-select', 'provider-form',
  'provider-auth-select', 'provider-secret-select', 'provider-model-select', 'provider-delete-confirm',
]);
const PROFILE_OPERATIONS = new Set(['edit', 'limits', 'test', 'delete']);
const MIN_CONTEXT_LIMIT_BYTES = 65_536;
const MAX_CONTEXT_LIMIT_BYTES = 16_777_216;
const DEFAULT_CONTEXT_LIMIT_BYTES = 2_097_152;
const MIN_OUTPUT_LIMIT_TOKENS = 1;
const MAX_OUTPUT_LIMIT_TOKENS = 1_048_576;
const DEFAULT_OUTPUT_LIMIT_TOKENS = DEFAULT_MODEL_OUTPUT_TOKENS;

const PRESETS = Object.freeze({
  'lm-studio': Object.freeze({ displayName: 'LM Studio', endpoint: 'http://127.0.0.1:1234/v1' }),
  ollama: Object.freeze({ displayName: 'Ollama', endpoint: 'http://127.0.0.1:11434/v1' }),
  compatible: Object.freeze({ displayName: 'OpenAI-compatible', endpoint: 'http://127.0.0.1:1234/v1' }),
});

export function isProviderSetupOverlay(overlay) {
  return SETUP_KINDS.has(overlay?.kind);
}

export function beginProviderManagement(action, workspace, sourceOverlay = {}) {
  const returnParent = parentFrom(sourceOverlay);
  if (action === 'add') {
    workspace.projection.openOverlay(presetOverlay(returnParent));
    return;
  }
  if (!PROFILE_OPERATIONS.has(action)) {
    throw new ContractError('provider_operation_invalid', `unknown provider operation: ${action}`);
  }
  const profiles = Object.values(workspace.activeConfig().providerProfiles);
  if (profiles.length === 0) {
    workspace.projection.showNotice('provider', 'Add a provider profile before using that action.');
    return;
  }
  workspace.projection.openOverlay(profileSelectionOverlay(action, profiles, returnParent));
}

export function beginProviderManagementSelection(selected, workspace, overlay) {
  if (overlay?.kind !== 'provider' || !selected?.id?.startsWith('action:')) return false;
  beginProviderManagement(selected.id.slice(7), workspace, overlay);
  return true;
}

export function handleProviderRoleNavigation(action, workspace) {
  const overlay = workspace.projection.overlay;
  if (overlay?.kind !== 'provider' || !['left', 'right'].includes(action.action)) return false;
  const roles = ['primary', 'subagent', 'reviewer', 'vision'];
  const current = Math.max(0, roles.indexOf(overlay.role));
  const direction = action.action === 'left' ? -1 : 1;
  const role = roles[(current + direction + roles.length) % roles.length];
  const projected = workspace.projection.active();
  const config = role === 'primary' ? workspace.activeConfig() : workspace.config;
  if (!config?.routes) throw new ContractError('provider_config_unavailable', 'provider routing configuration is unavailable');
  workspace.projection.openOverlay(providerOverlay({ config }, {
    role, inheritRoute: projected.role === 'primary' ? null : workspace.config?.routes?.primary ?? null,
    canManage: projected.role === 'primary' && role === 'primary',
    canAssign: projected.role === 'primary', isMain: projected.role === 'primary',
  }));
  return true;
}

export async function handleProviderSetupAction(action, workspace) {
  const overlay = workspace.projection.overlay; if (!isProviderSetupOverlay(overlay)) return false;
  if (overlay.kind === 'provider-form') return handleFormAction(action, workspace, overlay);
  if (['history_up', 'history_down'].includes(action.action)) {
    workspace.projection.moveOverlaySelection(action.action === 'history_up' ? -1 : 1);
    return true;
  }
  if (action.action === 'back') {
    openSetupBack(workspace, overlay);
    return true;
  }
  if (['cancel', 'help'].includes(action.action)) {
    workspace.projection.closeOverlay();
    return true;
  }
  if (action.action !== 'submit' || !overlay.items?.length) return true;
  const selected = overlay.items[overlay.selected];
  if (overlay.kind === 'provider-preset') {
    const preset = PRESETS[selected.id];
    workspace.projection.openOverlay(profileFormOverlay({
      operation: 'add', draft: { ...preset, credential: null, credentialEnv: '', model: '' }, stepIndex: 0,
      returnParent: overlay.returnParent,
    }));
  } else if (overlay.kind === 'provider-profile-select') {
    await selectProfileAction(selected.id, overlay, workspace);
  } else if (overlay.kind === 'provider-auth-select') {
    const next = { ...overlay.formState, draft: { ...overlay.formState.draft, credentialEnv: '' } };
    if (selected.id === 'environment') workspace.projection.openOverlay(credentialFormOverlay({ ...next, draft: { ...next.draft, credential: null } }));
    else if (selected.id === 'new') workspace.projection.openOverlay(newCredentialFormOverlay(next));
    else if (selected.id === 'saved') workspace.projection.openOverlay(await savedSecretOverlay(next, workspace));
    else if (selected.id === 'keep') await discoverModels(overlay.formState, workspace);
    else await discoverModels({ ...next, draft: { ...next.draft, credential: null } }, workspace);
  } else if (overlay.kind === 'provider-secret-select') {
    const [secretId, field] = selected.id.split('#');
    await discoverModels({
      ...overlay.formState,
      draft: { ...overlay.formState.draft, credential: { source: 'secret', secretId, field }, credentialEnv: '' },
    }, workspace);
  } else if (overlay.kind === 'provider-model-select') {
    if (selected.id === 'manual') {
      workspace.projection.openOverlay(modelFormOverlay(overlay.formState, overlay.discoveryError));
    } else {
      workspace.projection.openOverlay(modelSaveProgressOverlay(overlay, selected.id));
      workspace.onChange();
      try {
        await saveProfile({ ...overlay.formState, draft: { ...overlay.formState.draft, model: selected.id } }, workspace);
      } catch (error) {
        workspace.projection.openOverlay(modelSaveErrorOverlay(overlay, error));
      }
    }
  } else if (overlay.kind === 'provider-delete-confirm') {
    if (selected.id === 'cancel') openProviderManager(workspace, overlay.returnParent, overlay.profileId);
    else {
      await workspace.deleteProvider(overlay.profileId);
      openProviderManager(workspace, overlay.returnParent);
      workspace.projection.showNotice('provider', `Deleted unused provider ${overlay.profileId}.`);
    }
  }
  return true;
}
async function selectProfileAction(profileId, overlay, workspace) {
  const profile = workspace.activeConfig().providerProfiles[profileId];
  if (!profile) throw new ContractError('provider_profile_missing', `provider profile does not exist: ${profileId}`);
  if (!PROFILE_OPERATIONS.has(overlay.operation)) {
    throw new ContractError('provider_operation_invalid', `unknown provider operation: ${overlay.operation}`);
  }
  if (overlay.operation === 'test') {
    const result = await workspace.testProvider(profileId);
    workspace.projection.openOverlay(valueOverlay('provider-test', `Provider test · ${profileId}`, result));
  } else if (overlay.operation === 'delete') {
    workspace.projection.openOverlay(deleteConfirmationOverlay(profile, overlay.returnParent));
  } else if (overlay.operation === 'limits') {
    workspace.projection.openOverlay(limitsFormOverlay({
      operation: 'limits', profileId, returnParent: overlay.returnParent,
      draft: {
        contextLimitBytes: String(profile.contextLimitBytes ?? DEFAULT_CONTEXT_LIMIT_BYTES),
        outputLimitTokens: String(profile.outputLimitTokens ?? DEFAULT_OUTPUT_LIMIT_TOKENS),
      }, stepIndex: 0,
    }));
  } else if (overlay.operation === 'edit') {
    workspace.projection.openOverlay(profileFormOverlay({
      operation: 'edit', profileId, returnParent: overlay.returnParent,
      draft: {
        id: profile.id, displayName: profile.displayName, endpoint: profile.endpoint,
        credential: profile.credential ?? null, credentialEnv: profile.credentialEnv ?? '', model: profile.model,
      }, stepIndex: 0,
    }));
  }
}

async function handleFormAction(action, workspace, overlay) {
  if (action.action === 'back') {
    if (overlay.form.stepIndex > 0) openFormStep(workspace, overlay.form, overlay.form.stepIndex - 1);
    else openSetupBack(workspace, overlay);
    return true;
  }
  if (['cancel', 'help'].includes(action.action)) {
    workspace.projection.closeOverlay();
    return true;
  }
  if (action.action === 'submit') {
    try { await submitFormStep(workspace, overlay); }
    catch (error) {
      workspace.projection.openOverlay(formOverlay({ ...overlay.form, formError: error.message }, overlay.editor));
    }
    return true;
  } else if (handleFormEditing(action, overlay.editor)) { /* editor mutated */ }
  else return true;
  workspace.projection.openOverlay(formOverlay(overlay.form, overlay.editor));
  return true;
}

async function submitFormStep(workspace, overlay) {
  const form = overlay.form;
  const step = form.steps[form.stepIndex];
  const value = overlay.editor.text.trim();
  validateField(step.key, value, form);
  const next = { ...form, draft: { ...form.draft, [step.key]: value } };
  if (form.stepIndex < form.steps.length - 1) {
    openFormStep(workspace, next, form.stepIndex + 1);
    return;
  }
  if (form.operation === 'limits') {
    await workspace.editProvider(form.profileId, {
      contextLimitBytes: Number(next.draft.contextLimitBytes),
      outputLimitTokens: Number(next.draft.outputLimitTokens),
    });
    openProviderManager(workspace, form.returnParent, form.profileId);
    workspace.projection.showNotice('provider', `Updated declared model limits for ${form.profileId}.`);
    return;
  }
  if (form.mode === 'model') {
    await saveProfile({ ...form, draft: { ...form.draft, model: value } }, workspace);
    return;
  }
  if (form.mode === 'credential') {
    if (step.key === 'credentialValue') {
      const secret = await workspace.createSecret({
        label: await availableSecretLabel(workspace, `${form.draft.displayName} · API key`),
        kind: 'api_key', fields: { api_key: value },
      });
      await discoverModels({
        ...next, draft: { ...next.draft, credential: { source: 'secret', secretId: secret.id, field: 'api_key' }, credentialEnv: '' },
      }, workspace);
    } else await discoverModels({
      ...next, draft: { ...next.draft, credential: { source: 'environment', name: value } },
    }, workspace);
    return;
  }
  workspace.projection.openOverlay(authenticationOverlay(next));
}

async function discoverModels(form, workspace) {
  workspace.projection.openOverlay(progressOverlay(form));
  workspace.onChange();
  try {
    const discovered = await workspace.discoverProviderModels(form.draft);
    if (discovered.models.length === 0) throw new ContractError('provider_models_empty', 'the provider returned no models');
    workspace.projection.openOverlay(modelSelectionOverlay(form, discovered.models));
  } catch (error) {
    workspace.projection.openOverlay(modelFormOverlay(form, error.code ?? error.message ?? 'model discovery unavailable'));
  }
}

async function saveProfile(form, workspace) {
  const id = form.operation === 'add'
    ? availableProfileId(form.draft.displayName, Object.keys(workspace.activeConfig().providerProfiles))
    : form.profileId;
  const input = {
    id, displayName: form.draft.displayName, endpoint: form.draft.endpoint,
    model: form.draft.model, credential: form.draft.credential ?? null,
    credentialEnv: form.draft.credential?.source === 'environment' ? form.draft.credential.name : null,
  };
  if (form.operation === 'add') await workspace.addProvider(input);
  else await workspace.editProvider(form.profileId, {
    displayName: input.displayName, endpoint: input.endpoint, model: input.model,
    credential: input.credential, credentialEnv: input.credentialEnv,
  });
  openProviderManager(workspace, form.returnParent, form.operation === 'add' ? input.id : form.profileId);
  workspace.projection.showNotice('provider', `${form.operation === 'add' ? 'Added' : 'Updated'} provider ${form.operation === 'add' ? input.id : form.profileId}.`);
}

function validateField(key, value) {
  if (key === 'displayName' && (value.length < 1 || value.length > 128)) {
    throw new ContractError('provider_name_invalid', 'Profile name must contain 1–128 characters.');
  }
  if (key === 'endpoint') {
    let endpoint;
    try { endpoint = new URL(value); } catch { throw new ContractError('provider_endpoint_invalid', 'Enter a complete HTTP or HTTPS provider endpoint.'); }
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
      throw new ContractError('provider_endpoint_invalid', 'Provider endpoint must use HTTP(S) and cannot embed credentials.');
    }
  }
  if (key === 'credentialEnv' && value && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(value)) {
    throw new ContractError('provider_credential_invalid', 'Enter an environment-variable name, or leave this field blank.');
  }
  if (key === 'credentialValue' && (value.length < 1 || value.length > 20_000 || /[\r\n\u0000]/u.test(value))) {
    throw new ContractError('provider_credential_invalid', 'Enter an API key or token containing 1–20,000 characters without line breaks.');
  }
  if (key === 'model' && (value.length < 1 || value.length > 256)) {
    throw new ContractError('invalid_model', 'Model name must contain 1–256 characters.');
  }
  if (key === 'contextLimitBytes' && !boundedInteger(value, MIN_CONTEXT_LIMIT_BYTES, MAX_CONTEXT_LIMIT_BYTES)) {
    throw new ContractError('provider_context_limit_invalid', 'Context byte limit must be an integer from 65,536 through 16,777,216.');
  }
  if (key === 'outputLimitTokens' && !boundedInteger(value, MIN_OUTPUT_LIMIT_TOKENS, MAX_OUTPUT_LIMIT_TOKENS)) {
    throw new ContractError('provider_output_limit_invalid', 'Output-token limit must be an integer from 1 through 1,048,576.');
  }
}

function boundedInteger(value, minimum, maximum) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum;
}

function presetOverlay(returnParent) {
  return menu('provider-preset', 'Create provider profile', [
    'Choose a provider type. You can adjust every field before saving.',
    '',
    'NNA will query the endpoint and present its available models as the final step.',
  ], [
    { id: 'lm-studio', label: 'LM Studio', detail: 'Local OpenAI-compatible endpoint · http://127.0.0.1:1234/v1' },
    { id: 'ollama', label: 'Ollama', detail: 'Local OpenAI-compatible endpoint · http://127.0.0.1:11434/v1' },
    { id: 'compatible', label: 'OpenAI-compatible', detail: 'Local, private-network, or public HTTP(S) endpoint' },
  ], { returnParent, actionLabel: 'Up/Down choose · Enter continue' });
}

function profileSelectionOverlay(operation, profiles, returnParent) {
  const labels = { edit: 'Edit provider profile', limits: 'Set model limits', test: 'Test provider profile', delete: 'Delete provider profile' };
  return menu('provider-profile-select', labels[operation], [
    operation === 'edit' ? 'Choose a profile, then edit its fields in place.' : `Choose the profile to ${operation}.`,
  ], profiles.map((profile) => ({
    id: profile.id, label: profile.displayName, badge: profile.id,
    detail: `${profile.model} · ${profile.endpoint}`,
  })), { operation, returnParent, actionLabel: 'Up/Down choose · Enter continue' });
}

function profileFormOverlay(state) {
  const steps = [
    field('displayName', 'Provider label', 'A memorable name shown wherever you choose a provider profile.'),
    field('endpoint', 'LLM host', 'Complete OpenAI-compatible URL for the local, network, or hosted inference server; normally ending in /v1.'),
  ];
  return formOverlay({ ...state, steps });
}

function credentialFormOverlay(state) {
  return formOverlay({
    ...state, mode: 'credential', stepIndex: 0,
    steps: [field('credentialEnv', 'API key source', 'Environment-variable name containing the API key. The secret itself is never stored in this profile.')],
  });
}

function newCredentialFormOverlay(state) {
  return formOverlay({
    ...state, mode: 'credential', stepIndex: 0,
    steps: [formField('credentialValue', 'API key or token', 'Paste the credential. NNA will encrypt it in the Secret Broker.', { secret: true, limit: 20_000 })],
  });
}

function authenticationOverlay(formState) {
  const current = formState.draft.credential;
  const items = [];
  if (current) items.push({ id: 'keep', label: 'Keep current authentication', detail: current.source === 'secret' ? 'Continue using the selected Secret Broker record' : `Continue using environment variable ${current.name}` });
  items.push(
    { id: 'none', label: 'No authentication', detail: 'Connect without an Authorization header' },
    { id: 'new', label: 'Enter a new API key or token', detail: 'Encrypt a new credential in the Secret Broker and use it here' },
    { id: 'saved', label: 'Select a saved secret', detail: 'Use an enabled single-value credential already stored in NNA' },
    { id: 'environment', label: 'Use environment variable', detail: 'Advanced: read a credential managed outside NNA' },
  );
  return menu('provider-auth-select', 'Provider authentication', [
    'Choose how this LLM host authenticates model discovery and inference.',
    '', 'Local LM Studio and Ollama normally require no authentication.',
  ], items, { formState, actionLabel: 'Up/Down choose · Enter continue', activeId: current ? 'keep' : 'none' });
}

async function savedSecretOverlay(formState, workspace) {
  const secrets = (await workspace.listSecrets()).filter((secret) => secret.enabled
    && ['api_key', 'token', 'text'].includes(secret.kind) && secret.fields.length === 1);
  return menu('provider-secret-select', 'Select provider credential', [
    'Choose an enabled single-value secret. Stored values remain hidden.',
  ], secrets.map((secret) => ({
    id: `${secret.id}#${secret.fields[0]}`, label: secret.label,
    detail: `${secret.kind.replaceAll('_', ' ')} · field ${secret.fields[0]}`,
  })), { formState, actionLabel: 'Up/Down choose · Enter use secret' });
}

async function availableSecretLabel(workspace, base) {
  const labels = new Set((await workspace.listSecrets()).map((secret) => secret.label.toLocaleLowerCase('en-US')));
  if (!labels.has(base.toLocaleLowerCase('en-US'))) return base;
  for (let index = 2; index <= 9_999; index += 1) {
    const candidate = `${base} ${index}`;
    if (!labels.has(candidate.toLocaleLowerCase('en-US'))) return candidate;
  }
  throw new ContractError('secret_label_exhausted', 'Unable to choose a unique credential label.');
}

function limitsFormOverlay(state) {
  return formOverlay({ ...state, steps: [
    field('contextLimitBytes', 'Context byte limit', 'Bounded input-context ceiling for this profile.'),
    field('outputLimitTokens', 'Output token limit', 'Maximum declared output tokens for this profile.'),
  ] });
}

function modelFormOverlay(state, discoveryError) {
  return formOverlay({
    ...state, mode: 'model', stepIndex: 0, discoveryError,
    steps: [field('model', 'Default model', 'Enter the exact model identifier exposed by the provider.')],
  });
}

function formOverlay(form, existingEditor) {
  return createFormOverlay(form, {
    kind: 'provider-form',
    title: (state) => state.operation === 'add' ? 'Create provider profile'
      : state.operation === 'limits' ? 'Provider model limits' : 'Edit provider profile',
    limit: (step) => step.limit ?? (step.key === 'credentialEnv' ? 128 : 2_048),
    extraLines: (state) => state.discoveryError
      ? ['', `Model discovery unavailable · ${state.discoveryError}`] : [],
  }, existingEditor);
}

function modelSelectionOverlay(formState, models) {
  const unique = [...new Set(models)].slice(0, 4096);
  const items = unique.map((model) => ({
    id: model, label: model, badge: model === formState.draft.model ? 'current default' : '',
  }));
  items.push({ id: 'manual', label: 'Enter a model manually', detail: 'Use when the provider catalog omits the desired model.' });
  return menu('provider-model-select', `Choose model for ${formState.draft.displayName}`, [
    'Pick the default model for this provider profile. /model can temporarily select another model later.',
  ], items, {
    formState, actionLabel: 'Up/Down choose · Enter save profile',
    activeId: formState.draft.model,
  });
}

function modelSaveProgressOverlay(overlay, model) {
  return Object.freeze({
    ...overlay,
    title: `Saving provider profile · ${model}`,
    lines: Object.freeze([...overlay.lines, '', 'Applying this provider catalog to open conversations...']),
    items: Object.freeze([]),
    actionLabel: 'Saving provider profile',
  });
}

function modelSaveErrorOverlay(overlay, error) {
  const detail = error?.code ? `${error.code}: ${error.message}` : (error?.message ?? 'unknown provider save failure');
  return Object.freeze({
    ...overlay,
    lines: Object.freeze([...overlay.lines, '', `Could not save provider profile · ${detail}`]),
  });
}

function deleteConfirmationOverlay(profile, returnParent) {
  return createConfirmationOverlay('provider-delete-confirm', 'Delete provider profile', [
    `Profile   ${profile.displayName}`,
    `ID        ${profile.id}`,
    `Endpoint  ${profile.endpoint}`,
    '', 'Assigned profiles cannot be deleted. This action removes only the saved profile.',
  ], [
    { id: 'cancel', label: 'Keep profile', detail: 'Return without changing configuration.' },
    { id: 'delete', label: 'Delete profile', detail: 'Permanently remove this unused provider profile.' },
  ], { profileId: profile.id, returnParent, safeId: 'cancel' });
}

function progressOverlay(form) {
  return Object.freeze({
    kind: 'provider-form', title: 'Discovering provider models',
    lines: Object.freeze([`Connecting to ${form.draft.endpoint}`, '', 'Please wait…']),
    items: Object.freeze([]), selected: 0, offset: 0, actionLabel: 'Discovering models',
    form: Object.freeze(form), editor: formEditor('', 2_048),
  });
}

function openFormStep(workspace, form, stepIndex) {
  const next = { ...form, stepIndex, formError: undefined };
  workspace.projection.openOverlay(formOverlay(next));
}

function openSetupBack(workspace, overlay) {
  const parent = overlay.returnParent ?? overlay.form?.returnParent;
  if (overlay.kind === 'provider-form') {
    if (overlay.form.mode === 'model') workspace.projection.openOverlay(authenticationOverlay({ ...overlay.form, mode: undefined, discoveryError: undefined }));
    else if (overlay.form.mode === 'credential') workspace.projection.openOverlay(authenticationOverlay({ ...overlay.form, mode: undefined }));
    else if (overlay.form.operation === 'add') workspace.projection.openOverlay(presetOverlay(parent));
    else workspace.projection.openOverlay(profileSelectionOverlay(overlay.form.operation, Object.values(workspace.activeConfig().providerProfiles), parent));
  } else if (overlay.kind === 'provider-auth-select') {
    workspace.projection.openOverlay(profileFormOverlay({ ...overlay.formState, stepIndex: 1 }));
  } else if (overlay.kind === 'provider-secret-select') {
    workspace.projection.openOverlay(authenticationOverlay(overlay.formState));
  } else if (overlay.kind === 'provider-model-select') {
    workspace.projection.openOverlay(authenticationOverlay(overlay.formState));
  } else if (overlay.kind === 'provider-delete-confirm') {
    workspace.projection.openOverlay(profileSelectionOverlay('delete', Object.values(workspace.activeConfig().providerProfiles), parent));
  } else openProviderManager(workspace, parent);
}

function openProviderManager(workspace, returnParent, selectedId) {
  const projected = workspace.projection.active();
  if (!projected) throw new ContractError('provider_session_missing', 'no active conversation is available');
  const view = providerOverlay({ config: workspace.activeConfig() }, {
    role: 'primary', inheritRoute: projected.role === 'primary' ? null : workspace.config?.routes?.primary ?? null,
    canManage: projected.role === 'primary', canAssign: true,
    isMain: projected.role === 'primary', selectedId,
  });
  workspace.projection.openOverlay(returnParent ? { ...view, ...returnParent } : view);
}

function parentFrom(overlay) {
  return overlay.parent ? { parent: overlay.parent, configSection: overlay.configSection } : null;
}

export function availableProfileId(label, existingIds = []) {
  const stem = label.normalize('NFKD').replaceAll(/\p{Mark}/gu, '').toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-').replaceAll(/^-+|-+$/gu, '').slice(0, 56) || 'provider';
  const existing = new Set(existingIds);
  if (!existing.has(stem)) return stem;
  for (let index = 2; index <= 9999; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${stem.slice(0, 64 - suffix.length)}${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new ContractError('provider_id_exhausted', 'Unable to generate a unique provider profile identifier.');
}

function field(key, label, description) { return formField(key, label, description); }
function menu(kind, title, lines, items, extra = {}) {
  return createMenuOverlay(kind, title, lines, items, extra);
}
