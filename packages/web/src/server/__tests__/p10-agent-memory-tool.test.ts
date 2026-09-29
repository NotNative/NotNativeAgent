// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
process.env.NOTNATIVE_DATA_DIR = mkdtempSync(join(tmpdir(), 'nnd-p10-memory-tool-boot-'));
import { executeMemoryTool } from '../agent-tool/memory-actions.ts';
import { registerAgentToolCallback } from '../routes/agent-tool.ts';
import { subscribeControlEvents } from '../lib/bus.ts';
import { createMemoryEntry, readMemoryStore } from '../project-context/agent-memory.ts';
import { writeSettingsPatch } from '../lib/settings-store.ts';
import { ENV } from '../env.ts';

mkdirSync(ENV.dataDir, { recursive: true });
const primary = join(tmpdir(), 'nnd-p10-memory-owner-primary');
let primaryDirectory: string;

afterAll(() => {
  rmSync(ENV.dataDir, { recursive: true, force: true });
  rmSync(primary, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(join(ENV.dataDir, 'memory.json'), { force: true });
  rmSync(join(ENV.dataDir, 'projects'), { recursive: true, force: true });
  primaryDirectory = join(primary, 'session');
  mkdirSync(primaryDirectory, { recursive: true });
  process.env.OPENCHAMBER_MEMORY_ENABLE = 'true';
  writeSettingsPatch({ agentMemoryToolEnabled: true }, 'web');
});

function callback(projectDirectory: string): Hono {
  const instance = new Hono();
  registerAgentToolCallback(instance, 'token'.repeat(8));
  return instance;
}

function request(body: unknown, secret = 'token'.repeat(8)): RequestInit {
  return { method: 'POST', headers: {
    'content-type': 'application/json',
    authorization: secret ? `Bearer ${secret}` : '',
  }, body: JSON.stringify(body) };
}

describe('P10 agent memory tool', () => {
  it('is feature-gated and saves over duplicate entries without echoing the body', async () => {
    writeSettingsPatch({ agentMemoryToolEnabled: false }, 'web');
    expect(await executeMemoryTool({ action: 'memory.list' }, 'alpha')).toMatchObject({ status: 403 });
    writeSettingsPatch({ agentMemoryToolEnabled: true }, 'web');

    const saved = await executeMemoryTool({
      action: 'save', parameters: { title: 'Boundary rules', body: 'Use an isolated memory home.', type: 'preference' },
      scope: 'project',
    }, 'alpha');
    expect(saved).toMatchObject({ status: 200, value: { saved: true, replaced: false,
      memory: { title: 'Boundary rules', type: 'preference', scope: 'project' } } });
    const first = (saved.value as { memory: { memoryId: string } }).memory.memoryId;

    const replaced = await executeMemoryTool({
      action: 'memory.save', parameters: { title: 'Boundary rules', body: 'Use the corrected isolated memory home.' },
      scope: 'project',
    }, 'alpha');
    expect(replaced).toMatchObject({ status: 200, value: { replaced: true, memory: { memoryId: first } } });
    expect(JSON.stringify(replaced.value)).not.toContain('corrected isolated');
    expect(await readMemoryStore('project', 'alpha')).toHaveLength(1);
  });

  it('reads project before global and refuses absence while a scope failed', async () => {
    await createMemoryEntry(undefined, { title: 'Shared title', body: 'Global version.', scope: 'global' });
    await createMemoryEntry('alpha', { title: 'Shared title', body: 'Project version.', scope: 'project' });
    const read = await executeMemoryTool({ action: 'memory.read', parameters: { title: 'Shared title' } }, 'alpha');
    expect(read).toMatchObject({ status: 200, value: { title: 'Shared title', body: 'Project version.', scope: 'project' } });

    const listed = await executeMemoryTool({ action: 'memory.list', parameters: { scope: 'both' } }, 'alpha');
    expect(listed).toMatchObject({ status: 200, value: { memory: [
      { title: 'Shared title', scope: 'global' }, { title: 'Shared title', scope: 'project' },
    ] } });
  });

  it('requires the callback token, resolves a real directory owner, and emits one change', async () => {
    const events: Array<unknown> = [];
    const unsubscribe = subscribeControlEvents((event) => events.push(event));
    const app = callback(primaryDirectory);
    const denied = await app.request('/api/agent-tool/callback', request({
      tool: 'openchamber_memory', input: { action: 'memory.list' },
      contextDirectory: primaryDirectory,
    }, ''));
    expect(denied.status).toBe(401);

    const saved = await app.request('/api/agent-tool/callback', request({
      tool: 'openchamber_memory',
      input: { action: 'memory.save', parameters: { title: 'Owned callback', body: 'This store is owned by alpha.' }, scope: 'project' },
      contextDirectory: primaryDirectory,
      projects: [{ id: 'alpha', worktree: primary }],
    }));
    expect(saved.status).toBe(200);
    const payload = await saved.json() as { memory: { scope: string; memoryId: string } };
    expect(payload.memory).toMatchObject({ scope: 'project' });
    expect(await readMemoryStore('project', 'alpha')).toHaveLength(1);
    expect(events).toEqual([{ type: 'notnative:agent-memory-changed',
      payload: { scope: 'project', projectId: 'alpha' } }]);

    const unowned = await app.request('/api/agent-tool/callback', request({
      tool: 'openchamber_memory', input: { action: 'memory.list', parameters: {} },
      contextDirectory: primaryDirectory,
    }));
    expect(unowned.status).toBe(200);
    expect(await unowned.json()).toMatchObject({ memory: [] });
    expect(events).toHaveLength(1);
  });
});
