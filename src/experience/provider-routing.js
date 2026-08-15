// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { withRoleRoute, withRouteSetting, withoutProvider, withoutRoleRoute } from '../provider/route-configuration.js';
import { assertProviderUnused } from './provider-catalog.js';
import { publishWorkspaceConfiguration } from './configuration-publication.js';

const PRIMARY_ROLE = 'primary';
const SCOPES = Object.freeze({ global: 'workspace_global', conversation: 'conversation', default: 'workspace_default' });

export async function selectWorkspaceProviderRole(workspace, role, providerId) {
  const active = workspace._active();
  const current = routeConfiguration(active);
  const profile = current.providerProfiles[providerId];
  if (!profile) throw new ContractError('provider_missing', `provider ${providerId} is not configured`);
  if (role !== PRIMARY_ROLE) {
    workspace._requireMainSpecialistManagement();
    await workspace._publishSpecialistRoutes(withRoleRoute(workspace.config, role, providerId, profile.model));
    return { scope: SCOPES.global, role, providerId, model: profile.model };
  }
  const sessionNext = withRoleRoute(current, role, providerId, profile.model);
  const scope = await updatePrimaryRoute(workspace, active, sessionNext,
    withRoleRoute(workspace.config, role, providerId, profile.model),
    () => workspace._projectRoute(active.id, sessionNext.config.routes.primary));
  return { scope, role, providerId, model: profile.model };
}

export async function clearWorkspaceProviderRole(workspace, role) {
  if (role !== PRIMARY_ROLE) {
    workspace._requireMainSpecialistManagement();
    await workspace._publishSpecialistRoutes(withoutRoleRoute(workspace.config, role));
    return { scope: SCOPES.global, role, assigned: false };
  }
  const active = workspace._active();
  const current = routeConfiguration(active);
  const sessionNext = withoutRoleRoute(current, role);
  const scope = await updatePrimaryRoute(workspace, active, sessionNext, withoutRoleRoute(workspace.config, role));
  return { scope, role, assigned: false };
}

export async function configureWorkspaceProviderRoute(workspace, role, setting, value) {
  const active = workspace._active();
  const current = routeConfiguration(active);
  if (role !== PRIMARY_ROLE) {
    workspace._requireMainSpecialistManagement();
    await workspace._publishSpecialistRoutes(withRouteSetting(workspace.config, role, setting, value));
    return { scope: SCOPES.global, role, setting, value };
  }
  const sessionNext = withRouteSetting(current, role, setting, value);
  const scope = await updatePrimaryRoute(workspace, active, sessionNext,
    withRouteSetting(workspace.config, role, setting, value));
  return { scope, role, setting, value };
}

async function updatePrimaryRoute(workspace, active, sessionNext, globalNext, project = null) {
  const activeProjection = workspace.projection.active();
  if (!activeProjection) throw new ContractError('tui_session_missing', 'no active provider route is available');
  const isWorkspaceDefault = activeProjection.role === PRIMARY_ROLE;
  if (isWorkspaceDefault) {
    await publishWorkspaceConfiguration(workspace, [{ session: active, manifest: sessionNext.manifest }], globalNext);
  } else await workspace._updateSession(active, sessionNext.manifest);
  project?.();
  workspace.onChange();
  await workspace._savePoolRecoverable();
  return isWorkspaceDefault ? SCOPES.default : SCOPES.conversation;
}

function routeConfiguration(active) {
  const config = active.engine.pendingConfig ?? active.engine.config;
  if (!config) throw new ContractError('provider_configuration_missing', 'the active provider configuration is unavailable');
  return config;
}

export async function deleteWorkspaceProvider(workspace, id) {
  workspace._requireMainProviderManagement();
  assertProviderUnused(workspace.sessions, workspace.config, id);
  await workspace._publishProviderCatalog(withoutProvider(workspace.config, id));
  return { id, deleted: true };
}
