// SPDX-License-Identifier: Apache-2.0
/** HP-1 prompt/command/fork/archive/goal seams for session orchestration. */
import type { GoalPayload } from '../goals/goal-payload.ts';
import { callHarness, harnessRequest } from '../queue/queue-adapter-calls.ts';
import { READ_TIMEOUT_MS } from './session-harness-port-timeouts.ts';
import { idOf, status } from './session-harness-port-seams.ts';

export function createSessionWritePorts(): {
  sendPrompt: (sessionId: string, directory: string, body: Record<string, unknown>) => Promise<{ ok: boolean; status: number }>;
  sendCommand: (sessionId: string, directory: string, body: Record<string, unknown>) => Promise<{ ok: boolean; status: number }>;
  forkSession: (sessionId: string, directory: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  archiveSession: (sessionId: string, directory: string, archivedAt: number) => Promise<boolean>;
  writeGoal: (sessionId: string, directory: string, body: {
    goal: GoalPayload; expected_id: string | null; expected_revision: number;
  }) => Promise<boolean>;
  patchSession: (sessionId: string, directory: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  projects?: () => Promise<unknown[]>;
} {
  return {
    sendPrompt: (sessionId, directory, body) =>
      status(`/session/${idOf(sessionId)}/prompt_async`, directory, body),
    sendCommand: (sessionId, directory, body) =>
      status(`/session/${idOf(sessionId)}/command`, directory, body),
    forkSession: async (sessionId, directory, body) => {
      const response = await callHarness(harnessRequest(`/session/${idOf(sessionId)}/fork`, directory, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      }));
      if (!response.ok) throw new Error(`fork rejected with ${response.status}`);
      const record = await response.json().catch(() => null);
      if (record === null || typeof record !== 'object' || Array.isArray(record)) throw new Error('invalid fork record');
      return record as Record<string, unknown>;
    },
    archiveSession: async (sessionId, directory, archivedAt) => {
      const response = await callHarness(harnessRequest(`/session/${idOf(sessionId)}`, directory, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ time: { archived: archivedAt } }),
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      }));
      return response.ok;
    },
    writeGoal: async (sessionId, directory, body: {
      goal: GoalPayload; expected_id: string | null; expected_revision: number;
    }) => {
      const response = await callHarness(harnessRequest(`/v1/nnd/sessions/${idOf(sessionId)}/goal`, directory, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      }));
      return response.ok;
    },
    projects: () => callHarness(harnessRequest('/project', '', {
      method: 'GET', signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    })).then(async (response) => {
      if (!response.ok) return [];
      const value = await response.json().catch(() => null);
      return Array.isArray(value) ? value : [];
    }),
    patchSession: (sessionId, directory, body) => patchHarnessSession(sessionId, directory, body),
  };
}

async function patchHarnessSession(sessionId: string, directory: string,
  body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await callHarness(harnessRequest(`/session/${idOf(sessionId)}`, directory, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  }));
  if (!response.ok) throw new Error(`session patch rejected with ${response.status}`);
  const record = await response.json().catch(() => null);
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('invalid session patch record');
  }
  return record as Record<string, unknown>;
}
