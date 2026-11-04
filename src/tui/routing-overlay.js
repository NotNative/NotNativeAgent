// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { createMenuOverlay } from './surface-engine.js';

const ROLES = Object.freeze([
  Object.freeze({ id: 'primary', label: 'Primary', purpose: 'The model that answers an ordinary turn.' }),
  Object.freeze({ id: 'reviewer', label: 'Reviewer', purpose: 'The model that reviews a sealed tool request.' }),
  Object.freeze({ id: 'subagent', label: 'Sub-agent', purpose: 'The model that runs delegated work.' }),
  Object.freeze({ id: 'vision', label: 'Vision', purpose: 'The model that describes an attached image or video.' }),
]);
const GLOBAL_ROLES = Object.freeze(['reviewer', 'subagent', 'vision']);

// Why: one surface answers "who serves each role" without mixing in profile management. Each role
// resolves to its own selection or to the primary selection, so a row states which of the two it is.
export function routingOverlay(engine, options = {}) {
  const config = engine.config;
  const primary = config.routes.primary;
  const scope = options.isMain ? 'Main workspace default (new conversations copy this once)' : 'This conversation';
  const lines = [
    'Each role resolves to its own model selection, or to the primary selection.',
    '',
    `Scope  ${scope}`,
  ];
  const items = [];
  for (const role of ROLES) {
    const route = config.routes[role.id] ?? {};
    const assigned = role.id === 'primary' || route.assigned !== false;
    const connection = assigned ? config.connectionRecords[route.providerId] : null;
    const inherited = !assigned && role.id !== 'primary';
    items.push(Object.freeze({
      id: `role:${role.id}`, label: role.label,
      detail: inherited
        ? `${role.purpose} · follows Primary (${primary.model})`
        : `${role.purpose} · ${connection?.displayName ?? route.providerId} · ${route.model}`,
      badge: inherited ? 'inherit' : role.id === 'primary' ? 'primary' : 'assigned',
      section: 'Role resolution',
      role: role.id,
    }));
    // Why: only a global role can be cleared back to inheritance, and only Main owns that write.
    if (GLOBAL_ROLES.includes(role.id) && assigned && options.canManage) {
      items.push(Object.freeze({
        id: `clear:${role.id}`, label: `Clear ${role.label} assignment`,
        detail: `Return ${role.label} to the requesting conversation's Primary selection.`,
        section: 'Clear an assignment',
        role: role.id,
      }));
    }
  }
  if (options.canManage) {
    for (const role of ROLES.filter((item) => GLOBAL_ROLES.includes(item.id))) {
      for (const profile of Object.values(config.connectionRecords)) {
        items.push(Object.freeze({
          id: `assign:${role.id}:${profile.id}`, label: `${role.label} → ${profile.displayName}`,
          detail: `${profile.id} · ${profile.model} · ${profile.endpoint}`,
          section: `Assign ${role.label}`,
          role: role.id, providerId: profile.id,
        }));
      }
    }
  }
  return Object.freeze({
    ...createMenuOverlay('routing', 'Routing', lines, items, { activeId: options.selectedId ?? 'role:primary' }),
    actionLabel: options.canManage ? 'Up/Down choose · Enter apply' : 'Read only · manage from Main',
  });
}

export async function applyRoutingChoice(selected, workspace) {
  if (typeof selected?.id !== 'string') return;
  const [kind, role, providerId] = selected.id.split(':');
  // Why: a role row only displays its resolution; an assignment or a clear changes it.
  if (kind === 'clear' && role) await workspace.clearProviderForRole(role);
  else if (kind === 'assign' && role && providerId) await workspace.selectProviderForRole(role, providerId);
}

export async function handleRoutingCommand(argument, workspace, open) {
  if (argument) {
    const [role, target] = argument.split(/\s+/u);
    if (!ROLES.some((item) => item.id === role)) {
      throw new ContractError('route_role_invalid', 'routing accepts a known role and a provider, or "clear"');
    }
    if (target === 'clear') {
      await workspace.clearProviderForRole(role);
      return;
    }
    if (!target) throw new ContractError('provider_request_invalid', 'routing requires a provider identity or "clear"');
    await workspace.selectProviderForRole(role, target);
    return;
  }
  open(routingOverlay({ config: workspace.activeConfig() }, {
    isMain: workspace.projection.active()?.role === 'primary',
    canManage: workspace.projection.active()?.role === 'primary',
  }));
}
