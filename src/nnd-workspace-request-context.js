// SPDX-License-Identifier: Apache-2.0
/** Resolve executable workspace scope from authenticated native admission. */
export async function admittedWorkspaceContext(context) {
  const path = context.url.pathname;
  const workspaceRoute = path === '/project' || path === '/project/current'
    || path === '/session' || path.startsWith('/session/') || path === '/session/status'
    || path === '/global/event' || path === '/event' || path === '/v1/nnd/pending'
    || path === '/v1/nnd/activity-tombstones' || path.startsWith('/v1/nnd/sessions/');
  if (workspaceRoute && context.nndWorkspaceAdmissionService
    && context.principal.subjectId === 'nnd-local-operator'
    && context.principal.platformRole === 'operator'
    && context.principal.permissions.includes('nnd.workspace.manage')) {
    let inventory;
    try { inventory = await context.nndWorkspaceAdmissionService.inventory(context.principal); }
    catch (error) {
      // Why: an unavailable admitted root must not disable the attached root.
      if (error?.code === 'nnd_workspace_admission_identity_mismatch') return context;
      throw error;
    }
    return { ...context, workspaceInventory: inventory,
      principal: { ...context.principal, workspaceIds: [...new Set([
        ...context.principal.workspaceIds, ...inventory.admitted.map(row => row.id)])] } };
  }
  return context;
}
