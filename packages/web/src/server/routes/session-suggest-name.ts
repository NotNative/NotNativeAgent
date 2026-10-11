// SPDX-License-Identifier: Apache-2.0
/**
 * AI rename suggestion (W-24.ai-rename): propose a short session title from a
 * bounded transcript through the Small Model seam. The route NEVER applies the
 * name — the operator decides, and the existing rename PATCH path applies it,
 * so the suggestion cannot silently rewrite operator-visible state.
 */
import type { Hono } from 'hono';
import { createSessionReadPorts } from '../session-orchestration/session-harness-read-ports.ts';
import { generateSmallModel, type SmallModelPorts } from './small-model.ts';
import { SmallModelUnavailableError } from '../lib/small-model/service.ts';

const MAX_OUTPUT_TOKENS = 64;
const TRANSCRIPT_BUDGET = 6_000;
const MESSAGE_WINDOW = 40;
const NAME_SYSTEM_PROMPT = [
  'Return exactly one JSON object and nothing else — no prose, no markdown, no code fences.',
  'Shape: {"name": string}.',
  'name: 3 to 60 characters; a concise, specific session title reflecting the operator goal;',
  'no quotes, no trailing punctuation, same language as the conversation.',
].join('\n');
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

export function registerSessionSuggestNameRoute(app: Hono, ports: SmallModelPorts = {}): void {
  app.post('/api/sessions/:sessionID/suggest-name', async (context) => {
    const sessionID = context.req.param('sessionID');
    const directory = context.req.query('directory') ?? '';
    if (!ID_PATTERN.test(sessionID) || directory === '') {
      return Response.json({ error: 'sessionID and directory are required' }, { status: 400 });
    }
    const read = createSessionReadPorts();
    const messages = await read.readMessages(sessionID, directory, MESSAGE_WINDOW)
      .catch(() => null) as unknown;
    if (!Array.isArray(messages) || messages.length === 0) {
      return Response.json({ error: 'session unavailable or empty' }, { status: 404 });
    }
    const transcript = transcriptOf(messages);
    if (transcript === '') return Response.json({ error: 'session has no text to summarize' }, { status: 409 });
    try {
      const response = await generateSmallModel({
        prompt: transcript, system: NAME_SYSTEM_PROMPT, directory, sessionID,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      }, ports);
      const raw = (await response.json().catch(() => null)) as { text?: unknown } | null;
      if (raw === null || !response.ok || typeof raw.text !== 'string') {
        return Response.json({ error: 'name generation failed' }, { status: 502 });
      }
      const parsed = JSON.parse(raw.text) as { name?: unknown };
      const name = typeof parsed?.name === 'string' ? parsed.name.trim().slice(0, 80) : '';
      if (name.length < 3) return Response.json({ error: 'generated name was unusable' }, { status: 502 });
      return Response.json({ name });
    } catch (error) {
      if (error instanceof SmallModelUnavailableError) {
        return Response.json({ error: 'no small model is available' }, { status: 503 });
      }
      return Response.json({ error: 'name generation failed' }, { status: 502 });
    }
  });
}

/** Bounded transcript: "role: text" lines only, newest window, hard budget. */
export function transcriptOf(messages: unknown[]): string {
  const lines: string[] = [];
  let budget = TRANSCRIPT_BUDGET;
  for (const message of messages) {
    const shape = (message ?? {}) as { info?: { role?: unknown }, parts?: unknown[] };
    const role = shape.info?.role === 'assistant' ? 'Assistant' : shape.info?.role === 'user' ? 'Operator' : null;
    if (role === null || !Array.isArray(shape.parts)) continue;
    const text = shape.parts.flatMap((part) => {
      const item = (part ?? {}) as { type?: unknown; text?: unknown; synthetic?: unknown };
      return item.type === 'text' && item.synthetic !== true && typeof item.text === 'string' ? [item.text] : [];
    }).join(' ').trim();
    if (text === '') continue;
    const line = `${role}: ${text.slice(0, 1_500)}`;
    if (line.length > budget) break;
    budget -= line.length + 1;
    lines.push(line);
  }
  return lines.join('\n');
}
