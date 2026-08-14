// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { withRoleRoute, withRouteSetting, withoutProvider, withoutRoleRoute } from '../route-configuration.js';
import { assertProviderUnused } from './provider-catalog.js';
import { publishWorkspaceConfiguration } from './configuration-publication.js';

export async function selectWorkspaceProviderRole(workspace, role, providerId) {
  const active = workspace._active();
  const current = active.engine.pendingConfig ?? active.engine.config;
  const profile = current.providerProfiles[providerId];
  if (!profile) throw new ContractError('provider_missing', `provider ${providerId} is not configured`);
  if (role !== 'primary') {
    workspace._requireMainSpecialistManagement();
    await workspace._publishSpecialistRoutes(withRoleRoute(workspace.config, role, providerId, profile.model));
    return { scope: 'workspace_global', role, providerId, model: profile.model };
  }
  const sessionNext = withRoleRoute(current, role, providerId, profile.model);
  if (workspace.projection.active().role === 'primary') {
    const globalNext = withRoleRoute(workspace.config, role, providerId, profile.model);
    await publishWorkspaceConfiguration(workspace, [{ session: active, manifest: sessionNext.manifest }], globalNext);
  } else await workspace._updateSession(active, sessionNext.manifest);
  workspace._projectRoute(active.id, sessionNext.config.routes.primary);
  workspace.onChange();
  await workspace._savePoolRecoverable();
  return { scope: workspace.projection.active().role === 'primary' ? 'workspace_default' : 'conversation', role, providerId, model: profile.model };
}

export async function clearWorkspaceProviderRole(workspace, role) {
  if (role !== 'primary') {
    workspace._requireMainSpecialistManagement();
    await workspace._publishSpecialistRoutes(withoutRoleRoute(workspace.config, role));
    return { scope: 'workspace_global', role, assigned: false };
  }
  const active = workspace._active();
  const current = active.engine.pendingConfig ?? active.engine.config;
  const sessionNext = withoutRoleRoute(current, role);
  if (workspace.projection.active().role === 'primary') {
    const globalNext = withoutRoleRoute(workspace.config, role);
    await publishWorkspaceConfiguration(workspace, [{ session: active, manifest: sessionNext.manifest }], globalNext);
  } else await workspace._updateSession(active, sessionNext.manifest);
  workspace.onChange();
  await workspace._savePoolRecoverable();
  return { scope: workspace.projection.active().role === 'primary' ? 'workspace_default' : 'conversation', role, assigned: false };
}

export async function configureWorkspaceProviderRoute(workspace, role, setting, value) {
  const active = workspace._active();
  const current = active.engine.pendingConfig ?? active.engine.config;
  if (role !== 'primary') {
    workspace._requireMainSpecialistManagement();
    await workspace._publishSpecialistRoutes(withRouteSetting(workspace.config, role, setting, value));
    return { scope: 'workspace_global', role, setting, value };
  }
  const sessionNext = withRouteSetting(current, role, setting, value);
  if (workspace.projection.active().role === 'primary') {
    const globalNext = withRouteSetting(workspace.config, role, setting, value);
    await publishWorkspaceConfiguration(workspace, [{ session: active, manifest: sessionNext.manifest }], globalNext);
  } else await workspace._updateSession(active, sessionNext.manifest);
  workspace.onChange();
  await workspace._savePoolRecoverable();
  return { scope: workspace.projection.active().role === 'primary' ? 'workspace_default' : 'conversation', role, setting, value };
}

export async function deleteWorkspaceProvider(workspace, id) {
  workspace._requireMainProviderManagement();
  assertProviderUnused(workspace.sessions, workspace.config, id);
  await workspace._publishProviderCatalog(withoutProvider(workspace.config, id));
  return { id, deleted: true };
}
