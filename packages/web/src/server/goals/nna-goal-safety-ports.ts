// SPDX-License-Identifier: Apache-2.0
/** Production adapter for the NNA pre-audit goal safety tick. */
import { callHarness, callHarnessJson, harnessRequest } from '../queue/queue-adapter-calls.ts';
import { FETCH_TIMEOUT_MS, MESSAGE_FETCH_LIMIT } from './goal-constants.ts';
import type { GoalPayload } from './goal-payload.ts';
import type { GoalSafetyPorts } from './nna-goal-safety-tick.ts';
import { ObjectiveStore } from './objective-store.ts';

function path(id: string): string {
  return encodeURIComponent(id);
}

function get(route: string, directory: string): Promise<unknown> {
  return callHarnessJson(harnessRequest(route, directory, {
    method: 'GET', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }));
}

export function createNnaGoalSafetyPorts(store = new ObjectiveStore()): GoalSafetyPorts {
  return {
    listSessions: () => get('/session', ''),
    readSession: (id, directory) => get(`/session/${path(id)}`, directory),
    readStatus: (directory) => get('/session/status', directory),
    readChildren: (id, directory) => get(`/session/${path(id)}/children`, directory),
    readMessages: (id, directory, limit) => get(`/session/${path(id)}/message?limit=${Math.min(limit, MESSAGE_FETCH_LIMIT)}`, directory),
    readEvidence: (id, directory) => get(`/v1/nnd/sessions/${path(id)}/goal-evidence`, directory),
    readObjective: async (goal: GoalPayload, id: string) => {
      if (!goal.objectiveFile) return goal.objective;
      try { return (await store.read(id, goal.objectiveFileKey ?? '')) ?? goal.objective; }
      catch { return null; }
    },
    writeGoal: async (id, directory, body) => {
      const response = await callHarness(harnessRequest(`/v1/nnd/sessions/${path(id)}/goal`, directory, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }));
      if (!response.ok) return false;
      let result: unknown;
      try { result = await response.json(); } catch { return false; }
      const value = result as { goal?: unknown; revision?: unknown } | null;
      return value?.goal !== null && typeof value?.goal === 'object'
        && (value.goal as { id?: unknown }).id === body.goal.id
        && value.revision === body.expected_revision + 1;
    },
  };
}
