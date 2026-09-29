// SPDX-License-Identifier: Apache-2.0
/** P9-6b public HTTP facade and production dependency wiring. */
import type { Hono } from 'hono';
import type { SessionHarnessPorts } from './session-orchestration-contract.ts';
import {
  SESSION_BODY_MAX_CHARS, asRecord, fail, ok,
  type CreatedWorktree, type DispatchContext, type OrchestratorDeps, type OrchestratorSettings,
  type ResolvedSelection, type SelectionInput, type SessionOrchestrationError,
  type SessionOrchestrationResponse, type WorktreeRequest,
} from './session-orchestration-contract.ts';
import { readJsonBodyBounded } from '../lib/http/read-bounded.ts';
import { createAgentMemoryKnowledgeProvider } from '../agent-tool/memory-delivery.ts';
import { readMergedSettings } from '../lib/settings-store.ts';
import { ObjectiveStore } from '../goals/objective-store.ts';
import { createHarnessReadyPoll, createNnaSessionHarnessPorts } from './session-harness-ports.ts';
import { createSessionWorktree, waitForWorktree } from './session-worktree.ts';
import { archiveSessionIds, createSession, sendSession } from './session-orchestration-service.ts';
import { parseCreateBody, parseRunBody, safeDirectory } from './session-orchestration-input.ts';
import { goalIntro } from './session-orchestration-dispatch.ts';

export type { DispatchContext, OrchestratorDeps, OrchestratorSettings, ResolvedSelection, SelectionInput, SessionHarnessPorts, SessionOrchestrationError, SessionOrchestrationResponse, WorktreeRequest };
export { archiveSessionIds, createSession, sendSession };
export { goalIntro };
export type { CreatedWorktree };

function bodyOf(raw: Request): Promise<Record<string, unknown> | null> {
  return readJsonBodyBounded(raw, SESSION_BODY_MAX_CHARS);
}

async function envelope(outcome: Promise<SessionOrchestrationResponse>): Promise<Response> {
  const result = await outcome;
  if (result.ok) return Response.json(result.body);
  return Response.json({
    error: result.failure.error,
    ...(result.failure.partial !== undefined ? { partial: result.failure.partial } : {}),
    ...(result.failure.partialAction !== undefined ? { partialAction: result.failure.partialAction } : {}),
    ...(result.failure.sessionId !== undefined ? { sessionId: result.failure.sessionId } : {}),
    ...(result.failure.directory !== undefined ? { directory: result.failure.directory } : {}),
  }, { status: result.failure.status });
}

export function createOpenChamberSessionDeps(): OrchestratorDeps {
  const harness = createNnaSessionHarnessPorts();
  return {
    harness,
    knowledge: createAgentMemoryKnowledgeProvider(),
    directoryExists: safeDirectory,
    projectDirectory: async (projectId) => {
      const projects = await harness.projects?.() ?? [];
      for (const project of projects) {
        const record = asRecord(project);
        if (record?.id === projectId && typeof record.worktree === 'string' && record.worktree !== '') {
          return record.worktree;
        }
      }
      return null;
    },
    settingsFor: () => readMergedSettings('web') as OrchestratorSettings,
    objectiveStore: new ObjectiveStore(),
    createWorktree: createSessionWorktree,
    waitForWorktree,
    waitForHarnessReady: createHarnessReadyPoll(),
  };
}

export function registerOpenChamberSessionRoutes(app: Hono, custom?: OrchestratorDeps): void {
  const deps = custom ?? createOpenChamberSessionDeps();
  app.post('/api/openchamber/sessions', async (context) => {
    const body = await bodyOf(context.req.raw);
    if (body === null) return Response.json({ error: 'invalid JSON body' }, { status: 400 });
    const parsed = parseCreateBody(body);
    if (typeof parsed === 'string') return Response.json({ error: parsed }, { status: 400 });
    return await envelope(createSession(deps, parsed));
  });
  app.post('/api/openchamber/sessions/archive', async (context) => {
    const body = await bodyOf(context.req.raw);
    if (body === null) return Response.json({ error: 'invalid JSON body' }, { status: 400 });
    return await envelope(archiveSessionIds(deps, body.sessionIds));
  });
  app.post('/api/openchamber/sessions/:sessionId/send', async (context) => {
    const body = await bodyOf(context.req.raw);
    if (body === null) return Response.json({ error: 'invalid JSON body' }, { status: 400 });
    const parsed = parseRunBody(body);
    if (typeof parsed === 'string') return Response.json({ error: parsed }, { status: 400 });
    return await envelope(sendSession(deps, context.req.param('sessionId') ?? '', parsed, false));
  });
  app.post('/api/openchamber/sessions/:sessionId/fork', async (context) => {
    const body = await bodyOf(context.req.raw);
    if (body === null) return Response.json({ error: 'invalid JSON body' }, { status: 400 });
    const parsed = parseRunBody(body);
    if (typeof parsed === 'string') return Response.json({ error: parsed }, { status: 400 });
    return await envelope(sendSession(deps, context.req.param('sessionId') ?? '', parsed, true));
  });
}
