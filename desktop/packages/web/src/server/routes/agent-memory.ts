// SPDX-License-Identifier: Apache-2.0
/** Feature-gated admin reads and panel edits for agent memory storage. */
import type { Context, Hono } from 'hono';
import { agentMemoryEnabled, deleteMemoryEntry, readMemoryStore, updateMemoryEntry,
  type AgentMemoryScope } from '../project-context/agent-memory.ts';
import { announceAgentMemoryChange } from '../agent-tool/memory-events.ts';
import { readJsonBodyBounded } from '../lib/http/read-bounded.ts';

const AGENT_MEMORY_BODY_MAX = 64 * 1024;

function disabledMemory(c: Context): Response {
  return c.json({ error: 'Agent memory is disabled', disabled: true }, 404);
}

function scopeFrom(c: Context): { scope: AgentMemoryScope; projectId?: string } | null {
  const scope = c.req.query('scope');
  if (scope === 'global') return { scope };
  if (scope !== 'project') return null;
  const projectId = c.req.query('projectId') ?? '';
  return /^[A-Za-z0-9_-]+$/u.test(projectId) ? { scope, projectId } : null;
}

export function registerAgentMemoryRoutes(app: Hono): void {
  app.get('/api/agent-memory', async (c) => {
    if (!agentMemoryEnabled()) return disabledMemory(c);
    const selected = scopeFrom(c);
    if (!selected) return c.json({ error: 'valid agent memory scope is required' }, 400);
    try { return c.json({ version: 1, entries: await readMemoryStore(selected.scope, selected.projectId) }); }
    catch { return c.json({ error: 'agent memory is unavailable' }, 500); }
  });
  app.get('/api/agent-memory/all', async (c) => {
    if (!agentMemoryEnabled()) return disabledMemory(c);
    const projectId = c.req.query('projectId');
    try {
      const global = await readMemoryStore('global').catch(() => null);
      const project = typeof projectId === 'string' && /^[A-Za-z0-9_-]+$/u.test(projectId)
        ? await readMemoryStore('project', projectId).catch(() => null) : [];
      return c.json({ global: global ?? [], project: project ?? [], globalFailed: global === null, projectFailed: project === null });
    } catch { return c.json({ error: 'agent memory is unavailable' }, 500); }
  });
  app.patch('/api/agent-memory/:memoryId', async (c) => {
    if (!agentMemoryEnabled()) return disabledMemory(c);
    const selected = scopeFrom(c);
    if (!selected) return c.json({ error: 'valid agent memory scope is required' }, 400);
    const body = await readJsonBodyBounded(c.req.raw, AGENT_MEMORY_BODY_MAX);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'agent memory patch must be a JSON object' }, 400);
    }
    try {
      const touched = await updateMemoryEntry(selected.projectId, c.req.param('memoryId') ?? '',
        { scope: selected.scope, ...body as Record<string, unknown> });
      announceAgentMemoryChange({ scope: selected.scope,
        ...(selected.projectId ? { projectId: selected.projectId } : {}) });
      return c.json(touched);
    } catch (error) {
      const status = error instanceof Error && error.message === 'memory entry not found' ? 404
        : error instanceof Error && error.message.startsWith('invalid agent memory') ? 400 : 500;
      return c.json({ error: error instanceof Error ? error.message : 'agent memory update failed' }, status);
    }
  });
  app.delete('/api/agent-memory/:memoryId', async (c) => {
    if (!agentMemoryEnabled()) return disabledMemory(c);
    const selected = scopeFrom(c);
    if (!selected) return c.json({ error: 'valid agent memory scope is required' }, 400);
    try {
      const memoryId = c.req.param('memoryId') ?? '';
      if (!await deleteMemoryEntry(selected.projectId, selected.scope, memoryId)) {
        return c.json({ error: 'memory entry not found' }, 404);
      }
      announceAgentMemoryChange({ scope: selected.scope,
        ...(selected.projectId ? { projectId: selected.projectId } : {}) });
      return c.json({ deleted: true, memoryId });
    } catch { return c.json({ error: 'agent memory delete failed' }, 500); }
  });
}
