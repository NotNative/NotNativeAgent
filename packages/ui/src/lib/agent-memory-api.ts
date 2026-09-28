// SPDX-License-Identifier: Apache-2.0
/** Typed HTTP boundary for gated agent-owned memory; panel edits only. */
import { runtimeFetch } from './runtime-fetch.ts';

export type AgentMemoryScope = 'global' | 'project';
export type AgentMemoryType = 'fact' | 'preference' | 'reference';

export interface AgentMemoryEntry {
  id: string; title: string; body: string; type: AgentMemoryType;
  createdAt: number; updatedAt: number; sessionId?: string; flagged?: string;
}

export interface AgentMemoryOverview {
  global: AgentMemoryEntry[]; project: AgentMemoryEntry[];
  globalFailed: boolean; projectFailed: boolean;
}

export class AgentMemoryDisabledError extends Error {
  constructor() { super('Agent memory is disabled'); }
}

export class AgentMemoryRequestError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(`Agent memory request failed (${status})`);
  }
}

const PROJECT_ID = /^[A-Za-z0-9_-]+$/u;
const ENTRY_FIELDS = ['id', 'title', 'body', 'type', 'createdAt', 'updatedAt'] as const;

function scopePath(projectId: string | undefined, suffix = ''): string {
  if (projectId !== undefined && !PROJECT_ID.test(projectId)) throw new Error('Invalid project ID');
  const scope = projectId === undefined ? 'scope=global' : `scope=project&projectId=${encodeURIComponent(projectId)}`;
  return `/api/agent-memory${suffix}?${scope}`;
}

async function requestMemory(path: string, init?: RequestInit): Promise<unknown> {
  const response = await runtimeFetch(path, init);
  const value = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (response.ok) return value;
  if (value?.disabled === true) throw new AgentMemoryDisabledError();
  throw new AgentMemoryRequestError(response.status,
    typeof value?.error === 'string' ? value.error : 'Agent memory is unavailable');
}

export function usableMemory(value: unknown): value is AgentMemoryEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.id === 'string' && entry.id !== ''
    && typeof entry.title === 'string' && entry.title !== ''
    && typeof entry.body === 'string' && entry.body !== ''
    && (entry.type === 'fact' || entry.type === 'preference' || entry.type === 'reference')
    && Number.isSafeInteger(entry.createdAt) && Number.isSafeInteger(entry.updatedAt)
    && (entry.flagged === undefined || typeof entry.flagged === 'string')
    && ENTRY_FIELDS.every((field) => field in entry);
}

function memoryList(value: unknown): AgentMemoryEntry[] {
  if (!Array.isArray(value)) throw new Error('Invalid agent memory response');
  return value.filter(usableMemory);
}

export async function listAgentMemory(projectId?: string): Promise<AgentMemoryOverview> {
  const value = await requestMemory(`/api/agent-memory/all?${projectId ? `projectId=${encodeURIComponent(projectId)}` : ''}`);
  const overview = value as Partial<AgentMemoryOverview> | null;
  if (!overview || !Array.isArray(overview.global) || !Array.isArray(overview.project)
    || typeof overview.globalFailed !== 'boolean' || typeof overview.projectFailed !== 'boolean') {
    throw new Error('Invalid agent memory overview');
  }
  return { global: memoryList(overview.global), project: memoryList(overview.project),
    globalFailed: overview.globalFailed, projectFailed: overview.projectFailed };
}

export async function updateAgentMemory(projectId: string | undefined, memoryId: string,
  patch: { title?: string; body?: string; type?: AgentMemoryType },
): Promise<{ entry: AgentMemoryEntry; entries: AgentMemoryEntry[] }> {
  if (!memoryId) throw new Error('Invalid memory ID');
  const value = await requestMemory(scopePath(projectId, `/${encodeURIComponent(memoryId)}`), {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
  });
  const payload = value as { entry?: unknown; entries?: unknown };
  if (!usableMemory(payload?.entry) || !Array.isArray(payload?.entries)) {
    throw new Error('Invalid agent memory update response');
  }
  return { entry: payload.entry, entries: memoryList(payload.entries) };
}

export async function deleteAgentMemory(projectId: string | undefined, memoryId: string,
): Promise<{ deleted: boolean; memoryId: string }> {
  if (!memoryId) throw new Error('Invalid memory ID');
  const value = await requestMemory(scopePath(projectId, `/${encodeURIComponent(memoryId)}`), { method: 'DELETE' });
  const payload = value as { deleted?: unknown; memoryId?: unknown };
  if (payload?.deleted !== true || typeof payload.memoryId !== 'string') {
    throw new Error('Invalid agent memory delete response');
  }
  return { deleted: payload.deleted, memoryId: payload.memoryId };
}
