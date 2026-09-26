// SPDX-License-Identifier: Apache-2.0
/**
 * Production harness ports for the scheduled pipeline (doc 12 C.6): session
 * create, prompt/command dispatch, command catalog, session read, goal
 * write, project-directory resolution, and the ready poll. Everything rides
 * the internal harness adapter seam (`harnessRequest`), so the pipeline
 * logic stays port-shaped and testable without HTTP.
 */
import { callHarness, callHarnessJson, harnessRequest } from '../queue/queue-adapter-calls.ts';
import type { GoalPayload } from '../goals/goal-payload.ts';
import type { ScheduledHarnessPorts } from './scheduled-pipeline.ts';

const CREATE_CALL_TIMEOUT_MS = 10_000;
const SEND_CALL_TIMEOUT_MS = 30_000;
const READ_CALL_TIMEOUT_MS = 8_000;
const READY_POLL_MS = 250;
const READY_WINDOW_MS = 10_000;

function idSegment(id: string): string {
  return encodeURIComponent(id);
}

async function dispatch(route: string, directory: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number }> {
  const response = await callHarness(harnessRequest(route, directory, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SEND_CALL_TIMEOUT_MS),
  }));
  return { ok: response.ok, status: response.status };
}

export function createNnaScheduledHarnessPorts(): ScheduledHarnessPorts {
  return {
    createSession: async (directory, title) => {
      const response = await callHarness(harnessRequest('/session', directory, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ directory, title }),
        signal: AbortSignal.timeout(CREATE_CALL_TIMEOUT_MS),
      }));
      if (!response.ok) return null;
      try { return await response.json(); } catch { return null; }
    },
    sendPrompt: (sessionId, directory, body) =>
      dispatch(`/session/${idSegment(sessionId)}/prompt_async`, directory, body),
    sendCommand: (sessionId, directory, body) =>
      dispatch(`/session/${idSegment(sessionId)}/command`, directory, body),
    listCommands: (directory) =>
      callHarnessJson(harnessRequest('/command', directory, {
        method: 'GET', signal: AbortSignal.timeout(READ_CALL_TIMEOUT_MS),
      })),
    readSession: async (sessionId, directory) => {
      const response = await callHarness(harnessRequest(`/session/${idSegment(sessionId)}`, directory, {
        method: 'GET', signal: AbortSignal.timeout(READ_CALL_TIMEOUT_MS),
      }));
      if (!response.ok) return null;
      try { return await response.json(); } catch { return null; }
    },
    writeGoal: async (sessionId, directory, body: { goal: GoalPayload; expected_id: string | null; expected_revision: number }) => {
      const response = await callHarness(harnessRequest(`/v1/nnd/sessions/${idSegment(sessionId)}/goal`, directory, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(READ_CALL_TIMEOUT_MS),
      }));
      return response.ok;
    },
    resolveDirectory: async (projectId) => {
      const projects = await callHarnessJson(harnessRequest('/project', '', {
        method: 'GET', signal: AbortSignal.timeout(READ_CALL_TIMEOUT_MS),
      }));
      if (!Array.isArray(projects)) return null;
      for (const entry of projects) {
        if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
          const record = entry as Record<string, unknown>;
          if (record.id === projectId && typeof record.worktree === 'string' && record.worktree !== '') {
            return record.worktree;
          }
        }
      }
      return null;
    },
  };
}

/** C.6 step 2 ready poll: the command catalog answers cheaply; a window
 *  timeout is NOT fatal (the dispatch attempt itself is the fountain of
 *  truth - a still-cold harness rejects the create and the run records it). */
export function createHarnessReadyPoll(): () => Promise<boolean> {
  return async () => {
    const deadline = Date.now() + READY_WINDOW_MS;
    for (;;) {
      const response = await callHarness(harnessRequest('/command', '', { method: 'GET' })).catch(() => null);
      if (response !== null && response.ok) return true;
      if (Date.now() + READY_POLL_MS > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }
  };
}
