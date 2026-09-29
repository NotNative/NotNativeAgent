// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import './helpers/env-boot.ts';
import { createAgentMemoryKnowledgeProvider } from '../agent-tool/memory-delivery.ts';
import { announceAgentMemoryChange } from '../agent-tool/memory-events.ts';
import { createMemoryEntry } from '../project-context/agent-memory.ts';
import { writeSettingsPatch } from '../lib/settings-store.ts';
import { ENV } from '../env.ts';

beforeEach(() => {
  rmSync(join(ENV.dataDir, 'memory.json'), { force: true });
  rmSync(join(ENV.dataDir, 'projects'), { recursive: true, force: true });
  process.env.OPENCHAMBER_MEMORY_ENABLE = 'true';
  writeSettingsPatch({ agentMemoryToolEnabled: false }, 'web');
});

describe('P10 agent memory delivery', () => {
  it('delivers a project-scoped title index once until memory changes', async () => {
    writeSettingsPatch({ agentMemoryToolEnabled: true }, 'web');
    await createMemoryEntry(undefined, {
      title: 'Global preference', body: 'Prefer focused reviews.',
      scope: 'global', type: 'preference',
    });
    const directory = join(ENV.dataDir, 'projects', 'alpha');
    mkdirSync(directory, { recursive: true });
    await createMemoryEntry('alpha', {
      title: 'Project boundary', body: 'The store maps to this directory.',
    });
    const provider = createAgentMemoryKnowledgeProvider({
      projects: async () => [{ id: 'alpha', worktree: directory }],
    });

    try {
      const first = await provider.resolve('session-1', directory);
      expect(first).toContain('### About the user');
      expect(first).toContain('[preference] Global preference');
      expect(first).toContain('### About this project');
      expect(first).toContain('[fact] Project boundary');
      expect(first).not.toContain('worked');

      provider.recordDelivered('session-1', directory);
      expect(await provider.resolve('session-1', directory)).toBeNull();

      announceAgentMemoryChange({ scope: 'project', projectId: 'alpha' });
      expect(await provider.resolve('session-1', directory)).toBe(first);
    } finally {
      provider.dispose();
    }
  });

  it('stays blank when memory is switched off or the directory is unusable', async () => {
    const provider = createAgentMemoryKnowledgeProvider({
      projects: async () => [],
    });
    try {
      expect(await provider.resolve('session-1', 'not/absolute')).toBeNull();
    } finally {
      provider.dispose();
    }
  });

  it('delivers again in a different session', async () => {
    writeSettingsPatch({ agentMemoryToolEnabled: true }, 'web');
    await createMemoryEntry('alpha', { title: 'Shared context', body: 'Visible by title only.' });
    const directory = join(ENV.dataDir, 'projects', 'alpha');
    mkdirSync(directory, { recursive: true });
    const provider = createAgentMemoryKnowledgeProvider({
      projects: async () => [{ id: 'alpha', worktree: directory }],
    });

    try {
      const text = await provider.resolve('session-1', directory);
      provider.recordDelivered('session-1', directory);
      expect(await provider.resolve('session-2', directory)).toBe(text);
    } finally {
      provider.dispose();
    }
  });
});
