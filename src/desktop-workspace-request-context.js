// SPDX-License-Identifier: Apache-2.0
/** Resolve executable workspace scope from authenticated native admission. */
export async function admittedWorkspaceContext(context) {
  const path = context.url.pathname;
  const workspaceRoute = path === '/project' || path === '/project/current'
    || path === '/session' || path.startsWith('/session/') || path === '/session/status'
    || path === '/global/event' || path === '/event' || path === '/v1/desktop/pending'
    || path === '/v1/desktop/activity-tombstones' || path.startsWith('/v1/desktop/sessions/');
  if (workspaceRoute && context.desktopWorkspaceAdmissionService
    && context.principal.subjectId === 'desktop-local-operator'
    && context.principal.platformRole === 'operator'
    && context.principal.permissions.includes('desktop.workspace.manage')) {
    let inventory;
    try { inventory = await context.desktopWorkspaceAdmissionService.inventory(context.principal); }
    catch (error) {
      // Why: an unavailable admitted root must not disable the attached root.
      if (error?.code === 'desktop_workspace_admission_identity_mismatch') return context;
      throw error;
    }
    return { ...context, workspaceInventory: inventory,
      principal: { ...context.principal, workspaceIds: [...new Set([
        ...context.principal.workspaceIds, ...inventory.admitted.map(row => row.id)])] } };
  }
  return context;
}
