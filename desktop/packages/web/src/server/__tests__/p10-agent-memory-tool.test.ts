// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import './helpers/env-boot.ts';
import { executeMemoryTool } from '../agent-tool/memory-actions.ts';
import { registerAgentToolCallback } from '../routes/agent-tool.ts';
import { AGENT_TOOL_BODY_MAX_BYTES } from '../agent-tool/memory-render.ts';
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

  it('rejects a type that only coerces to a valid string', async () => {
    const result = await executeMemoryTool({
      action: 'memory.save',
      parameters: { title: 'Array type', body: 'Use the literal enum value.', type: ['preference'] },
    }, 'alpha');
    expect(result).toMatchObject({ status: 400, value: { error: 'invalid agent memory type' } });
  });

  it('never reports absence while a default read scope is unavailable', async () => {
    await createMemoryEntry('alpha', {
      title: 'Available only here', body: 'Use the project fallback carefully.', scope: 'project',
    });
    await writeFile(join(ENV.dataDir, 'memory.json'), 'not-json');
    const result = await executeMemoryTool({
      action: 'memory.read', parameters: { title: 'Missing title' },
    }, 'alpha');
    expect(result).toMatchObject({
      status: 503,
      value: { unavailableScope: ['global'] },
    });
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

  it('lets explicit parameters win for both storage and change notification', async () => {
    const events: Array<unknown> = [];
    const unsubscribe = subscribeControlEvents((event) => events.push(event));
    const app = callback(primaryDirectory);
    const saved = await app.request('/api/agent-tool/callback', request({
      tool: 'openchamber_memory',
      input: {
        action: 'save',
        scope: 'global',
        parameters: { title: 'Explicit wins', body: 'The project parameters decide.', scope: 'project' },
      },
      contextDirectory: primaryDirectory,
      projects: [{ id: 'alpha', worktree: primary }],
    }));
    expect(saved.status).toBe(200);
    expect(await readMemoryStore('project', 'alpha')).toHaveLength(1);
    expect(await readMemoryStore('global')).toHaveLength(0);
    expect(events).toEqual([{ type: 'notnative:agent-memory-changed',
      payload: { scope: 'project', projectId: 'alpha' } }]);

    const canonical = await app.request('/api/agent-tool/callback', request({
      tool: 'openchamber_memory',
      input: {
        action: 'memory.save',
        parameters: { title: 'Canonical alias', body: 'The default owner store.' },
      },
      contextDirectory: primaryDirectory,
      projects: [{ id: 'alpha', worktree: primary }],
    }));
    expect(canonical.status).toBe(200);
    expect(await readMemoryStore('project', 'alpha')).toHaveLength(2);
    expect(await readMemoryStore('global')).toHaveLength(0);
    expect(events).toMatchObject([
      { type: 'notnative:agent-memory-changed', payload: { scope: 'project', projectId: 'alpha' } },
      { type: 'notnative:agent-memory-changed', payload: { scope: 'project', projectId: 'alpha' } },
    ]);
    unsubscribe();
  });

  it('bounds callback bodies by decoded UTF-8 bytes, not Unicode characters', async () => {
    const app = callback(primaryDirectory);
    const source = {
      tool: 'openchamber_memory', input: { action: 'memory.list', parameters: {} },
      contextDirectory: primaryDirectory, projects: [{ id: 'alpha', worktree: primary }], filler: '',
    };
    const body = (size: number): Buffer => {
      source.filler = '';
      const bare = JSON.stringify(source);
      const paddingBytes = Math.max(0, size - Buffer.byteLength(bare));
      source.filler = '\u00e9'.repeat(Math.floor(paddingBytes / 2)) + (paddingBytes % 2 ? 'a' : '');
      return Buffer.from(JSON.stringify(source));
    };
    const wire = (payload: Buffer) => ({ method: 'POST', headers: {
      'content-type': 'application/json', authorization: `Bearer ${'token'.repeat(8)}`,
    }, body: payload });
    const exact = await app.request('/api/agent-tool/callback',
      wire(body(AGENT_TOOL_BODY_MAX_BYTES)));
    expect(exact.status).toBe(200);
    const oversize = await app.request('/api/agent-tool/callback',
      wire(body(AGENT_TOOL_BODY_MAX_BYTES + 1)));
    expect(oversize.status).toBe(400);
  });
});
