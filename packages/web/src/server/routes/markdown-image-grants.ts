// SPDX-License-Identifier: Apache-2.0
/** §G.6 mint narrowly-scoped markdown-image grants from assistant text. */

import { stat } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute } from 'node:path';
import type { Hono } from 'hono';
import { collectMarkdownImageDestinations } from '../lib/markdown-image-grants/markdown-image-parser.ts';
import type { PreparedImageFile } from '../lib/markdown-image-grants/image-file-resolver.ts';
import { prepareImageFile } from '../lib/markdown-image-grants/image-file-resolver.ts';
import { readJsonBodyBounded } from '../lib/http/read-bounded.ts';

const BODY_MAX_CHARS = 32 * 1024;
const MAX_SOURCES = 12;
const MESSAGE_LIMIT = 1000;

export interface MarkdownImageSessionPorts {
  readMessages: (sessionId: string, directory: string, limit: number) => Promise<unknown[]>;
}

export function registerMarkdownImageGrantRoutes(
  app: Hono,
  ports: MarkdownImageSessionPorts,
): void {
  app.post('/api/openchamber/sessions/:sessionId/markdown-image-grants', async (context) => {
    try {
      return await prepare(context, ports);
    } catch {
      return Response.json({ error: 'Failed to prepare session images' }, { status: 503 });
    }
  });
}

interface RequestShape {
  sessionId: string;
  directory: string;
  messageId: string;
  sources: string[];
}

async function prepare(context: { req: { param: (name: string) => string; raw: Request } }, ports: MarkdownImageSessionPorts): Promise<Response> {
  const input = await readInput(context);
  if (typeof input === 'string') return Response.json({ error: input }, { status: 400 });
  let workspaceRoot = '';
  if (!isAbsolute(input.directory)) return Response.json({ error: 'Directory must be a real directory' }, { status: 400 });
  try {
    const directoryStats = await stat(input.directory);
    if (!directoryStats.isDirectory()) return Response.json({ error: 'Directory must be a real directory' }, { status: 400 });
    workspaceRoot = await realpath(input.directory);
  } catch {
    return Response.json({ error: 'Directory must be a real directory' }, { status: 400 });
  }
  const message = await findAssistantMessage(ports, input);
  if (message === null) return Response.json({ error: 'Assistant message not found' }, { status: 404 });
  const referenced = collectMessageImages(message);
  const referencedSet = new Set(referenced);
  const requests = [...new Set(input.sources)].filter((source) => referencedSet.has(source));
  const tempRoot = await realpath(tmpdir());
  const validations = new Map<string, Promise<PreparedImageFile>>();
  for (const source of requests) {
    validations.set(source, prepareImageFile(source, workspaceRoot, tempRoot));
  }
  const results = await Promise.all(input.sources.map(async (source): Promise<Record<string, unknown>> => {
    const validation = validations.get(source);
    if (validation === undefined) return { source, status: 'error' };
    const outcome = await validation;
    return outcome.status === 'ready'
      ? {
        source,
        status: 'ready',
        path: outcome.path,
        ...(outcome.outsideFileGrant === undefined ? {} : { outsideFileGrant: outcome.outsideFileGrant }),
        ...(outcome.expiresAt === undefined ? {} : { expiresAt: outcome.expiresAt }),
      }
      : { source, status: outcome.status };
  }));
  return Response.json({ results });
}

async function readInput(context: { req: { param: (name: string) => string; raw: Request } }): Promise<RequestShape | string> {
  const sessionId = context.req.param('sessionId').trim();
  const body = await readJsonBodyBounded(context.req.raw, BODY_MAX_CHARS);
  if (body === null || sessionId === '') return 'sessionId, messageId, and 1-12 sources are required';
  const { directory, messageId, sources } = body;
  if (typeof directory !== 'string' || typeof messageId !== 'string'
    || !Array.isArray(sources) || sources.length === 0 || sources.length > MAX_SOURCES
    || sources.some((source) => typeof source !== 'string' || source === '')
  ) {
    return 'sessionId, messageId, and 1-12 sources are required';
  }
  return { sessionId, directory, messageId, sources: sources as string[] };
}

async function findAssistantMessage(ports: MarkdownImageSessionPorts, input: RequestShape): Promise<Record<string, unknown> | null> {
  const messages = await ports.readMessages(input.sessionId, input.directory, MESSAGE_LIMIT);
  for (const message of messages) {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) continue;
    const info = (message as { info?: unknown }).info;
    if (info === null || typeof info !== 'object' || Array.isArray(info)) continue;
    const { id, role } = info as { id?: unknown; role?: unknown };
    if (id === input.messageId && role === 'assistant') return message as Record<string, unknown>;
  }
  return null;
}

function collectMessageImages(message: Record<string, unknown>): string[] {
  const destinations: string[] = [];
  const seen = new Set<string>();
  const parts = Array.isArray((message as { parts?: unknown }).parts) ? (message.parts as unknown[]) : [];
  for (const part of parts) {
    if (part === null || typeof part !== 'object' || Array.isArray(part)) continue;
    const { type, text } = part as { type?: unknown; text?: unknown };
    if (type !== 'text' || typeof text !== 'string' || text === '') continue;
    for (const destination of collectMarkdownImageDestinations(text)) {
      if (!seen.has(destination)) {
        seen.add(destination);
        destinations.push(destination);
      }
    }
  }
  return destinations;
}
