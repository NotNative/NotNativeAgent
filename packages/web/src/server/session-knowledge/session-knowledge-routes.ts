// SPDX-License-Identifier: Apache-2.0
/** Additive session-knowledge routes (doc 15 §B.6/§B.7). */
import { Hono, type Context } from 'hono';
import { readJsonBodyBounded } from '../lib/http/read-bounded.ts';
import {
  productionDependencies, pinKnowledge, recordKnowledgeDelivered, resolveKnowledge,
  resolveKnowledgeSummary, type KnowledgeDependencies,
} from './knowledge-runtime.ts';
import { sessionID, signature } from './metadata.ts';

const BODY_MAX = 64 * 1024;

export function registerSessionKnowledgeRoutes(app: Hono,
  deps: KnowledgeDependencies = productionDependencies()): void {
  app.get('/api/session-knowledge', (c) => knowledge(c, deps));
  app.get('/api/session-knowledge/summary', (c) => summary(c, deps));
  app.post('/api/session-knowledge/pin', (c) => pin(c, deps));
  app.post('/api/session-knowledge/delivered', (c) => delivered(c, deps));
}

async function knowledge(c: Context, deps: KnowledgeDependencies): Promise<Response> {
  const directory = c.req.query('directory') ?? '';
  const requestedSession = c.req.query('sessionId') ?? undefined;
  const resolvedSession = requestedSession === '' ? undefined : sessionID(requestedSession);
  if (directory === '' || (requestedSession !== undefined && resolvedSession === undefined)) {
    return c.json({ error: 'invalid session knowledge directory or session ID' }, 400);
  }
  return c.json(await resolveKnowledge(deps, directory, resolvedSession));
}

async function summary(c: Context, deps: KnowledgeDependencies): Promise<Response> {
  const directory = c.req.query('directory') ?? '';
  const requestedSession = c.req.query('sessionId') ?? undefined;
  const resolvedSession = requestedSession === '' ? undefined : sessionID(requestedSession);
  if (requestedSession !== undefined && resolvedSession === undefined) {
    return c.json({ error: 'invalid session ID' }, 400);
  }
  return c.json(await resolveKnowledgeSummary(deps, directory, resolvedSession));
}

interface ParsedPinInput {
  sessionId: string; directory: string; kind: 'note' | 'plan'; id: string; pinned: boolean;
}

function parsePinInput(body: Record<string, unknown> | null,
  directoryDefault: string | undefined): ParsedPinInput | undefined {
  if (!body) return undefined;
  const sessionId = sessionID(body.sessionId);
  const directory = typeof body.directory === 'string' && body.directory !== ''
    ? body.directory : directoryDefault;
  const kind = body.kind === 'note' ? 'note' as const
    : body.kind === 'plan' ? 'plan' as const : undefined;
  const id = typeof body.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,399}$/u.test(body.id)
    ? body.id : undefined;
  if (!sessionId || !directory || !kind || !id || typeof body.pinned !== 'boolean') return undefined;
  return { sessionId, directory, kind, id, pinned: body.pinned };
}

async function pin(c: Context, deps: KnowledgeDependencies): Promise<Response> {
  const body = await readJsonBodyBounded(c.req.raw, BODY_MAX);
  const input = parsePinInput(body, c.req.query('directory'));
  if (!input) return c.json({ error: 'invalid session-knowledge pin request' }, 400);
  try {
    const result = await pinKnowledge(deps, input);
    if (result === null) return c.json({ error: 'session unavailable' }, 502);
    return c.json(result);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'session-knowledge pin failed',
    }, 502);
  }
}

async function delivered(c: Context, deps: KnowledgeDependencies): Promise<Response> {
  const body = await readJsonBodyBounded(c.req.raw, BODY_MAX);
  if (!body) return c.json({ error: 'invalid session-knowledge delivery' }, 400);
  const sessionId = sessionID(body.sessionId);
  const directory = typeof body.directory === 'string' && body.directory !== '' ? body.directory : undefined;
  const knownSignature = signature(body.signature);
  if (!sessionId || !directory || !knownSignature) {
    return c.json({ error: 'invalid session-knowledge delivery request' }, 400);
  }
  return c.json(await recordKnowledgeDelivered(deps, {
    sessionId, directory, signature: knownSignature,
  }));
}
