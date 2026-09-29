// SPDX-License-Identifier: Apache-2.0
/** Agent-memory title delivery for server-owned prompt senders. */
import { createHash } from 'node:crypto';
import { subscribeControlEvents } from '../lib/bus.ts';
import { CONTROL_EVENTS } from '../lib/harnessNaming.ts';
import { harnessRequest, callHarnessJson } from '../queue/queue-adapter-calls.ts';
import type { ProjectKnowledgeProvider } from '../queue/queue-hooks.ts';
import type { OwnershipProject } from '../project-context/agent-memory-ownership.ts';
import { sessionMemoryContent } from './memory-actions.ts';

export interface AgentKnowledgeOptions {
  projects?: () => Promise<readonly unknown[] | unknown[] | readonly OwnershipProject[] | OwnershipProject[]>;
}

export type AgentMemoryKnowledgeProvider = ProjectKnowledgeProvider & { dispose: () => void };

const PROJECT_READ_TIMEOUT_MS = 8_000;

function projectRecords(values: readonly unknown[]): readonly OwnershipProject[] {
  return values.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    return typeof record.id === 'string' && typeof record.worktree === 'string' && record.worktree !== ''
      ? [{ id: record.id, worktree: record.worktree }]
      : [];
  });
}

export function createAgentMemoryKnowledgeProvider(options: AgentKnowledgeOptions = {}): AgentMemoryKnowledgeProvider {
  let currentProjects: readonly OwnershipProject[] = [];
  const pending = new Map<string, string>();
  const delivered = new Map<string, string>();
  const unsubscribe = subscribeControlEvents((event) => {
    if (event.type === CONTROL_EVENTS.agentMemoryChanged) {
      pending.clear();
      delivered.clear();
    }
  });

  const readProjects = async (): Promise<readonly OwnershipProject[]> => {
    if (options.projects === undefined) {
      const values = await callHarnessJson(harnessRequest('/project', '', {
        method: 'GET', signal: AbortSignal.timeout(PROJECT_READ_TIMEOUT_MS),
      }));
      return Array.isArray(values) ? projectRecords(values) : [];
    }
    return projectRecords(await options.projects());
  };

  return {
    resolve: async (_sessionId: string, directory: string): Promise<string | null> => {
      try {
        currentProjects = await readProjects();
        const result = await sessionMemoryContent({ contextDirectory: directory, projects: currentProjects });
        if (result.content === undefined) return null;
        const signature = createHash('sha256').update(result.content).digest('hex');
        const key = `${_sessionId}${directory}`;
        if (delivered.get(key) === signature) return null;
        pending.set(key, signature);
        return result.content;
      } catch { return null; }
    },
    recordDelivered: (_sessionId: string, _directory: string): void => {
      const key = `${_sessionId}${_directory}`;
      const signature = pending.get(key);
      if (signature !== undefined) {
        pending.delete(key);
        delivered.set(key, signature);
      }
    },
    dispose: unsubscribe,
  };
}
