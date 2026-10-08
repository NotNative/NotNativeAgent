// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { describe, sessionIdOrder } from './nnd-session-description.js';
import { requirePrincipal, samePrincipal } from './nnd-session-helpers.js';

export function listNndSessions(contexts, children, principal, options = {}) {
  requirePrincipal(principal);
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) {
    throw new ContractError('request_invalid', 'NND session list limit must be a positive integer');
  }
  const parents = [...contexts.values()].filter((context) => !context.closing && samePrincipal(context, principal)
    && (options.includeArchived === true || !context.archivedAt)).map(describe).sort(sessionIdOrder);
  const visible = new Set(parents.map((session) => session.id));
  const childRows = (children.list?.(principal) ?? []).filter((child) => visible.has(child.parentID)).sort(sessionIdOrder);
  const listed = options.roots === true ? parents : options.roots === false ? childRows : [...parents, ...childRows];
  return options.limit === undefined ? listed : listed.slice(0, options.limit);
}

export function nndSessionStatuses(contexts, children, principal) {
  requirePrincipal(principal);
  const statuses = children.statuses?.(principal) ?? {};
  for (const context of contexts.values()) {
    if (!context.closing && samePrincipal(context, principal) && context.engine.active && !context.engine.active.finalized) {
      statuses[context.sessionId] = { type: 'busy' };
    }
  }
  return statuses;
}
