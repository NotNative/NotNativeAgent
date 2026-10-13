// SPDX-License-Identifier: Apache-2.0
/** P10-63 §5.29 resolver and generation gates. */

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { registerSmallModelRoutes, type SmallModelPorts } from '../routes/small-model.ts';

const providers = async () => [
  { id: 'openai', name: 'OpenAI', options: { apiKey: 'openai-key' }, models: {
    'gpt-nano': { id: 'gpt-nano', api: { url: 'https://api.openai.com/v1' }, limit: { context: 40_000, output: 4_000 } },
  } },
  { id: 'anthropic', name: 'Anthropic', options: { apiKey: 'anthropic-key' }, models: {
    'claude-haiku': { id: 'claude-haiku', api: { url: 'https://api.anthropic.com/v1' }, limit: { context: 30_000, output: 2_000 } },
  } },
  { id: 'google', name: 'Google', options: { apiKey: 'google-key' }, models: {
    'gemini-flash': {
      id: 'gemini-flash', api: { url: 'https://generativelanguage.googleapis.com/v1beta/models' },
      limit: { context: 50_000, output: 3_000 }, release_date: '2026-01-01',
    },
  } },
];

function fixture(options: Partial<SmallModelPorts> = {}): Hono {
  const app = new Hono();
  registerSmallModelRoutes(app, {
    providers,
    config: async () => ({ small_model: 'nnd-mock/mock-small' }),
    settings: async () => ({}),
    authFile: joinPath('auth.json'),
    fetch: vi.fn(async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"answer":1}' }] } }],
    }), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
    ...options,
  });
  return app;
}

function joinPath(name: string): string {
  return 'temp/' + name;
}

describe('small-model routes', () => {
  it('reports family scan readiness only when the resolved provider can generate', async () => {
    const app = fixture();
    const response = await app.request('/api/small-model?directory=/home/demo');
    expect(response.status).toBe(200);
    const body = await response.json() as { available: boolean; model: Record<string, unknown>; authenticatedProviders: string[] };
    expect(body.available).toBe(true);
    expect(body.model).toMatchObject({
      id: 'gemini-flash', providerID: 'google', hasLogin: true, supported: true,
      inputCharBudget: 188_000, contextTokens: 50_000, outputTokens: 3_000,
    });
    expect(body.authenticatedProviders).toContain('google');
  });

  it('uses the model endpoint, OpenCode session header, and bounded fields for Google generation', async () => {
    let observedURL = '';
  const fetchStub: typeof fetch = vi.fn(async (url: URL, init: RequestInit): Promise<Response> => {
      observedURL = `${url}`;
      expect((init.headers as Headers).get('x-goog-api-key')).toBe('google-key');
      expect(JSON.parse(String(init.body))).toMatchObject({
        contents: [{ role: 'user', parts: [{ text: 'short' }] }],
        generationConfig: { maxOutputTokens: 123, thinkingConfig: { thinkingBudget: 0 } },
      });
      return Response.json({ candidates: [{ content: { parts: [{ text: '{"answer":1}' }] } }] });
    }) as unknown as typeof fetch;
    const app = fixture({ fetch: fetchStub });
    const response = await app.request('/api/small-model/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'short', maxOutputTokens: 123, directory: '/home/demo',
        sessionID: 'ses-one',
      }),
    });
    expect(response.status).toBe(200);
    expect(observedURL).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash:generateContent');
    const body = await response.json() as { text: string; providerID: string; modelID: string };
    expect(body).toMatchObject({ text: '{"answer":1}', providerID: 'google', modelID: 'gemini-flash' });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('honors an explicit override and detects no small model', async () => {
    const override = fixture({
      settings: async () => ({ smallModelUseDefault: false, smallModelOverride: 'openai/gpt-nano' }),
      fetch: vi.fn(async () => Response.json({
        choices: [{ message: { content: 'done' } }],
      })) as unknown as typeof fetch,
    });
    const generated = await override.request('/api/small-model/generate', {
      method: 'POST', body: JSON.stringify({ prompt: 'hi' }),
    });
    expect(await generated.json()).toMatchObject({ text: 'done', providerID: 'openai', modelID: 'gpt-nano' });
    const absent = fixture({ providers: async () => [] });
    expect((await absent.request('/api/small-model/generate', {
      method: 'POST', body: JSON.stringify({ prompt: 'hi' }),
    })).status).toBe(404);
  });

  it('refuses OpenCode-hosted public-key sentinels and reports selected model readiness', async () => {
    const app = fixture({
      providers: async () => [
        { id: 'zen', options: { apiKey: 'public' }, models: {
          'gemini-flash': { id: 'gemini-flash', api: { url: 'https://example.invalid/v1beta/models' }, limit: { context: 10_000, output: 1_000 } },
        } },
      ],
    });
    const readiness = await app.request('/api/small-model');
    expect(await readiness.json()).toMatchObject({ available: false, model: null });
    const selected = fixture();
    const response = await selected.request('/api/small-model?providerID=openai&modelID=gpt-nano');
    expect(await response.json()).toMatchObject({
      available: true, model: { providerID: 'openai', id: 'gpt-nano' },
    });
  });

  it('rejects malformed and unauthenticated generation instead of broader 500s', async () => {
    const authless = fixture({
      authFile: 'missing.json',
      providers: async () => (await providers()).map((provider) => ({ ...provider, options: {} })),
    });
    expect((await authless.request('/api/small-model/generate', {
      method: 'POST', body: JSON.stringify({ prompt: 'short' }),
    })).status).toBe(404);
    expect((await authless.request('/api/small-model/generate', {
      method: 'POST', body: 'not json',
    })).status).toBe(400);
    expect((await authless.request('/api/small-model/generate', {
      method: 'POST', body: JSON.stringify({ prompt: 'short', model: 'bad-model' }),
    })).status).toBe(400);
  });

  it('keeps provider fetch failures as Hidden secret-free Small Model failures', async () => {
    const app = fixture({
      fetch: vi.fn(async () => new Response('refresh token leaked', { status: 500 })) as unknown as typeof fetch,
    });
    const response = await app.request('/api/small-model/generate', {
      method: 'POST', body: JSON.stringify({ prompt: 'short' }),
    });
    expect(response.status).toBe(502);
    const body = await response.json() as Record<string, unknown>;
    expect(JSON.stringify(body)).toContain('Small Model');
    expect(JSON.stringify(body)).not.toContain('refresh token leaked');
  });
});
