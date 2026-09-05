// SPDX-License-Identifier: Apache-2.0
import { createMenuOverlay } from './surface-engine.js';

export function profileSelectionOverlay(operation, profiles, returnParent) {
  const labels = { edit: 'Edit provider profile', limits: 'Set model limits', 'tool-calls': 'Set tool-call mode', test: 'Test provider profile', delete: 'Delete provider profile' };
  return createMenuOverlay('provider-profile-select', labels[operation], [
    operation === 'edit' ? 'Choose a profile, then edit its fields in place.' : `Choose the profile to ${operation}.`,
  ], profiles.map((profile) => ({
    id: profile.id, label: profile.displayName, badge: profile.id,
    detail: `${profile.model} · ${profile.endpoint}`,
  })), { operation, returnParent, actionLabel: 'Up/Down choose · Enter continue' });
}

export function toolCallModeOverlay(profile, returnParent) {
  return createMenuOverlay('provider-tool-call-mode', `Tool calls · ${profile.displayName}`, [
    'Single sends a provider control that limits each response to one tool call.',
    'Batch omits that control for providers that reject it. NNA still reviews every call.',
  ], [
    { id: 'single', label: 'Single call', badge: profile.toolCallMode === 'single' ? 'active' : '', detail: 'Default · send parallel_tool_calls: false' },
    { id: 'batch', label: 'Compatible batch', badge: profile.toolCallMode === 'batch' ? 'active' : '', detail: 'Omit the provider control and accept one or more calls' },
  ], { profileId: profile.id, returnParent, activeId: profile.toolCallMode });
}

export async function applyProviderDeletion(workspace, overlay, selection) {
  if (selection === 'cancel') return overlay.profileId;
  await workspace.deleteProvider(overlay.profileId);
  workspace.projection.showNotice('provider', `Deleted unused provider ${overlay.profileId}.`);
  return undefined;
}

export async function applyProviderToolCallMode(workspace, overlay, mode) {
  await workspace.editProvider(overlay.profileId, { toolCallMode: mode });
  workspace.projection.showNotice('provider', `Updated tool-call mode for ${overlay.profileId} to ${mode}.`);
}
