// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const reads = vi.hoisted(() => ({ messages: null as unknown | null, session: null as unknown }));
const generated = vi.hoisted(() => ({ impl: null as null | (() => Promise<Response>) }));
vi.mock('../session-orchestration/session-harness-read-ports.ts', () => ({
  createSessionReadPorts: () => ({
    readSession: async () => reads.session,
    readMessages: async () => reads.messages,
  }),
}));
vi.mock('../routes/small-model.ts', () => ({
  generateSmallModel: async () => {
    if (!generated.impl) throw new Error('generate not configured');
    return generated.impl();
  },
  SmallModelUnavailableError: class extends Error {},
}));
vi.mock('../lib/small-model/service.ts', async (importOriginal) => await importOriginal());

import { registerSessionSuggestNameRoute, transcriptOf } from '../routes/session-suggest-name.ts';

function app(): Hono {
  const application = new Hono();
  registerSessionSuggestNameRoute(application);
  return application;
}

function harnessMessages(): unknown[] {
  return [
    { info: { role: 'user', id: 'u1' }, parts: [{ type: 'text', text: 'Fix the login bug in the OAuth flow' }] },
    { info: { role: 'assistant', id: 'a1' }, parts: [{ type: 'text', text: 'Patched the token refresh.' }, { type: 'tool', callID: 'c1' }] },
  ];
}

afterEach(() => { generated.impl = null; reads.messages = null; });

describe('POST /api/sessions/:sessionID/suggest-name (W-24.ai-rename)', () => {
  it('returns a bounded generated name from the Small Model seam', async () => {
    reads.messages = harnessMessages();
    generated.impl = async () => new Response(JSON.stringify({ text: '{"name":"OAuth login fix"}' }), { status: 200 });
    const response = await app().request('/api/sessions/ses_x1/suggest-name?directory=D%3A%2Fwork', { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: 'OAuth login fix' });
  });

  it('rejects an unusable generation and an unknown or empty session', async () => {
    reads.messages = harnessMessages();
    generated.impl = async () => new Response(JSON.stringify({ text: '{"name":"ok"}' }), { status: 200 });
    expect((await app().request('/api/sessions/ses_x1/suggest-name?directory=D%3A%2Fwork', { method: 'POST' })).status).toBe(502);
    generated.impl = async () => new Response('boom', { status: 500 });
    expect((await app().request('/api/sessions/ses_x1/suggest-name?directory=D%3A%2Fwork', { method: 'POST' })).status).toBe(502);
    reads.messages = [];
    expect((await app().request('/api/sessions/ses_x1/suggest-name?directory=D%3A%2Fwork', { method: 'POST' })).status).toBe(404);
    expect((await app().request('/api/sessions/ses_x1/suggest-name', { method: 'POST' })).status).toBe(400);
  });

  it('maps Small Model unavailability to 503 and never writes session state', async () => {
    reads.messages = harnessMessages();
    const { SmallModelUnavailableError } = await import('../lib/small-model/service.ts');
    generated.impl = async () => { throw new SmallModelUnavailableError('none'); };
    const response = await app().request('/api/sessions/ses_x1/suggest-name?directory=D%3A%2Fwork', { method: 'POST' });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'no small model is available' });
  });
});

describe('transcriptOf (bounded suggest-name input)', () => {
  it('keeps role text lines, drops synthetic parts and non-text parts, and respects the budget', () => {
    const transcript = transcriptOf([
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world', synthetic: true }] },
      { info: { role: 'assistant' }, parts: [{ type: 'tool' }, { type: 'text', text: 'done' }] },
      { info: { role: 'system' }, parts: [{ type: 'text', text: 'noise' }] },
    ]);
    expect(transcript).toBe('Operator: hello\nAssistant: done');
    expect(transcriptOf([])).toBe('');
    const long = 'x'.repeat(2_000);
    const budgeted = transcriptOf(Array.from({ length: 10 }, (_, at) => ({ info: { role: 'user' }, parts: [{ type: 'text', text: long }] })));
    expect(budgeted.length).toBeLessThanOrEqual(6_100);
  });
});
