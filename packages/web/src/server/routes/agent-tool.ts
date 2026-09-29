// SPDX-License-Identifier: Apache-2.0
/** Private NNA-child callback; UI sessions and URL tokens grant no access. */
import { timingSafeEqual } from 'node:crypto';
import type { Hono } from 'hono';
import { executeMemoryTool } from '../agent-tool/memory-actions.ts';
import { announceAgentMemoryChange } from '../agent-tool/memory-events.ts';
import { AGENT_TOOL_BODY_MAX_BYTES } from '../agent-tool/memory-render.ts';
import { readJsonBodyBounded } from '../lib/http/read-bounded.ts';
import { resolveMemoryOwnership, type OwnershipInputs } from '../project-context/agent-memory-ownership.ts';
import type { AgentMemoryScope } from '../project-context/agent-memory.ts';

function secretMatches(actual: string | undefined, expected: string): boolean {
  if (!actual || !expected) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function ownershipInput(source: Record<string, unknown>): OwnershipInputs {
  const projects = Array.isArray(source.projects) ? source.projects.flatMap((project) => {
    if (!project || typeof project !== 'object' || Array.isArray(project)) return [];
    const record = project as Record<string, unknown>;
    return typeof record.id === 'string' && typeof record.worktree === 'string'
      ? [{ id: record.id, worktree: record.worktree }] : [];
  }) : [];
  return {
    directory: typeof source.contextDirectory === 'string' ? source.contextDirectory : undefined,
    managedChatsRoot: typeof source.managedChatsRoot === 'string' ? source.managedChatsRoot : undefined,
    projects,
  };
}

function mutationScope(source: Record<string, unknown>, projectId: string | undefined):
  { scope: AgentMemoryScope; projectId?: string } | undefined {
  if (source.tool !== 'openchamber_memory') return undefined;
  const input = source.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const action = (input as Record<string, unknown>).action;
  if (action !== 'memory.save' && action !== 'save' && action !== 'memory.delete' && action !== 'delete') {
    return undefined;
  }
  const scope: AgentMemoryScope = (input as Record<string, unknown>).scope === 'global' ? 'global' : 'project';
  return { scope, ...(scope === 'project' && projectId !== undefined ? { projectId } : {}) };
}

export function registerAgentToolCallback(app: Hono, secret: string): void {
  app.post('/api/agent-tool/callback', async (c) => {
    const bearer = c.req.header('authorization');
    if (!secretMatches(bearer?.startsWith('Bearer ') ? bearer.slice(7) : undefined, secret)) {
      return c.json({ error: 'managed tool callback credential is invalid' }, 401);
    }
    const body = await readJsonBodyBounded(c.req.raw, AGENT_TOOL_BODY_MAX_BYTES);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'managed tool callback must be a JSON object' }, 400);
    }
    const source = body as Record<string, unknown>;
    if (source.tool !== 'openchamber_memory') {
      return c.json({ error: 'unsupported managed tool call' }, 400);
    }
    let owner: string;
    try { owner = resolveMemoryOwnership(ownershipInput(source)); }
    catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'invalid memory owner' }, 400);
    }
    const result = await executeMemoryTool(source.input, owner, 'openchamber_memory');
    if (result.status === 200) {
      const changed = mutationScope(source, owner);
      if (changed) announceAgentMemoryChange(changed);
    }
    return c.json(result.value, result.status as 200 | 400 | 404 | 503);
  });
}
