// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { modelOverlay, providerOverlay, valueOverlay } from './overlays.js';

const PRIMARY_ROLE = 'primary';
const PROVIDER_MUTATIONS = new Set(['add', 'edit', 'limits']);

export async function handleProviderCommand(argument, workspace, helpers) {
  const values = argument.split(/\s+/u).filter(Boolean);
  if (PROVIDER_MUTATIONS.has(values[0])) return mutateProvider(values, workspace, helpers);
  if (values[0] === 'delete') {
    requireLength(values, 2, 'use /provider delete ID');
    await workspace.deleteProvider(values[1]);
    workspace.projection.showNotice('provider', `Deleted unused provider ${values[1]}.`);
    return;
  }
  if (values[0] === 'test') {
    requireLength(values, 2, 'use /provider test ID');
    const result = await workspace.testProvider(values[1]);
    workspace.projection.openOverlay(valueOverlay('provider-test', `Provider test · ${values[1]}`, result));
    return;
  }
  if (values.length > 2) throw invalid('use /provider, /provider ID, /provider ROLE ID, or a provider management command');
  if (values.length === 2) {
    if (values[1] === 'clear') await workspace.clearProviderForRole(values[0]);
    else await workspace.selectProviderForRole(values[0], values[1]);
    const scope = providerRouteScope(values[0], workspace.projection.active()?.role);
    workspace.projection.showNotice('route', `${values[0]} assignment ${values[1] === 'clear' ? 'cleared' : 'updated'} for ${scope}.`);
    return;
  }
  if (values.length === 1) {
    await workspace.selectProviderForRole(PRIMARY_ROLE, values[0]);
    workspace.projection.showNotice('route', helpers.routeNotice(workspace));
    return;
  }
  const projected = workspace.projection.active();
  if (!projected) throw new ContractError('provider_session_missing', 'no active conversation is available');
  workspace.projection.openOverlay(providerOverlay({ config: workspace.activeConfig() }, {
    role: PRIMARY_ROLE, inheritRoute: projected.role === PRIMARY_ROLE ? null : workspace.config?.routes?.primary ?? null,
    canManage: projected.role === PRIMARY_ROLE, isMain: projected.role === PRIMARY_ROLE, canAssign: true,
  }));
}

export async function handleModelCommand(argument, workspace, helpers) {
  if (argument === 'qualify') {
    const result = await workspace.qualifyActiveModel();
    workspace.projection.openOverlay(valueOverlay('model-qualification', `Model qualification · ${result.model}`, result));
    return;
  }
  if (argument) {
    await workspace.selectModel(argument);
    workspace.projection.showNotice('route', helpers.modelNotice(workspace));
    return;
  }
  let models, discoveryError;
  try { models = await workspace.availableModels(); } catch (error) {
    models = [workspace.activeConfig().routes.primary.model];
    discoveryError = error.code ?? error.message ?? 'provider unavailable';
  }
  const projected = workspace.projection.active();
  if (!projected) throw new ContractError('provider_session_missing', 'no active conversation is available');
  workspace.projection.openOverlay(modelOverlay({ config: workspace.activeConfig() }, models, {
    discoveryError, inheritRoute: projected.role === PRIMARY_ROLE ? null : workspace.config?.routes?.primary ?? null,
  }));
}

async function mutateProvider(values, workspace, helpers) {
  if (values[0] === 'add') {
    if (values.length < 4 || values.length > 5) throw invalid('use /provider add ID ENDPOINT MODEL [CREDENTIAL_ENV]');
    await workspace.addProvider({ id: values[1], endpoint: values[2], model: values[3], credentialEnv: values[4] });
    workspace.projection.showNotice('provider', `Added provider ${values[1]}.`);
  } else if (values[0] === 'edit') {
    if (values.length < 4 || values.length > 5) throw invalid('use /provider edit ID ENDPOINT MODEL [CREDENTIAL_ENV|-]');
    const input = { endpoint: values[2], model: values[3] };
    if (values.length === 5) input.credentialEnv = values[4] === '-' ? null : values[4];
    await workspace.editProvider(values[1], input);
    workspace.projection.showNotice('provider', `Updated provider ${values[1]}. A backup was retained.`);
  } else {
    requireLength(values, 4, 'use /provider limits ID CONTEXT_BYTES OUTPUT_TOKENS');
    await workspace.editProvider(values[1], {
      contextLimitBytes: helpers.strictInteger(values[2], 'context byte limit'),
      outputLimitTokens: helpers.strictInteger(values[3], 'output token limit'),
    });
    workspace.projection.showNotice('provider', `Updated declared model limits for ${values[1]}.`);
  }
}

function requireLength(values, length, message) {
  if (values.length !== length) throw invalid(message);
}

function invalid(message) {
  return new ContractError('provider_command_invalid', message);
}

function providerRouteScope(role, activeRole) {
  if (role !== PRIMARY_ROLE) return 'all conversations';
  return activeRole === PRIMARY_ROLE ? 'the Main workspace default' : 'this conversation';
}
