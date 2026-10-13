// SPDX-License-Identifier: Apache-2.0
/** Server control event emitted when agent memory changes. */
export const AGENT_MEMORY_CHANGED = 'notnative:agent-memory-changed';

export interface AgentMemoryChangedEvent {
  scope: 'global' | 'project';
  projectId?: string;
}

export function agentMemoryChange(value: unknown): AgentMemoryChangedEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (source.scope !== 'global' && source.scope !== 'project') return null;
  if (source.projectId !== undefined && (typeof source.projectId !== 'string' || source.projectId === '')) return null;
  return { scope: source.scope, ...(source.projectId === undefined ? {} : { projectId: source.projectId }) };
}
