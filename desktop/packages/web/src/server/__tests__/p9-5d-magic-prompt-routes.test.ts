// SPDX-License-Identifier: Apache-2.0
/** P9-5d magic-prompt override routes (doc 03 §5.31): store shape, validation,
 * per-id replacement/reset, and reset-all over a real temporary data dir. */
import { Hono } from 'hono';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath, sep } from 'node:path';
import { describe, afterAll } from 'vitest';
import { expect, it } from 'vitest';

const ROOT = mkdtempSync(`${tmpdir()}${sep}nnd-p95d-magic-prompts-`);
const dataDir = joinPath(ROOT, 'data');

const { registerMagicPromptRoutes } = await import('../routes/magic-prompts.ts');
const { magicPromptFileFor } = await import('../magic-prompts/prompt-store.ts');

const app = new Hono();
registerMagicPromptRoutes(app, { dataDir });

const call = async (path: string, init?: RequestInit): Promise<Response> =>
  app.fetch(new Request(`http://t.test${path}`, {
    headers: { 'content-type': 'application/json' }, ...init,
  })) as Promise<Response>;

const put = (path: string, body: unknown): Promise<Response> =>
  call(path, { method: 'PUT', body: JSON.stringify(body) });

afterAll(() => { rmSync(ROOT, { recursive: true, force: true }); });

describe('magic prompt routes (P9-5d)', () => {
  it('stores, reads, and atomically replaces overrides', async () => {
    expect((await (await call('/api/magic-prompts')).json())).toEqual({ version: 1, overrides: {} });
    const first = await put('/api/magic-prompts/session.fusion.visible', {
      text: 'Reconcile {{results}}',
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ version: 1, overrides: { 'session.fusion.visible': 'Reconcile {{results}}' } });

    const pushed = await put('/api/magic-prompts/session.fusion.instructions', {
      text: 'Reconcile competing outputs.',
    });
    expect(await pushed.json()).toEqual({ version: 1, overrides: {
      'session.fusion.visible': 'Reconcile {{results}}',
      'session.fusion.instructions': 'Reconcile competing outputs.',
    } });
    const replaced = await put('/api/magic-prompts/session.fusion.visible', { text: 'final' });
    expect(((await replaced.json()) as { overrides: Record<string, string> }).overrides).toEqual({
      'session.fusion.visible': 'final',
      'session.fusion.instructions': 'Reconcile competing outputs.',
    });
    const stored = JSON.parse(readFileSync(magicPromptFileFor(dataDir), 'utf8'));
    expect(stored.version).toBe(1);
    expect(stored.overrides['session.fusion.visible']).toBe('final');

    const removed = await call('/api/magic-prompts/session.fusion.visible', { method: 'DELETE' });
    expect(await removed.json()).toEqual({ version: 1, overrides: {
      'session.fusion.instructions': 'Reconcile competing outputs.',
    } });
    await call('/api/magic-prompts/session.fusion.instructions', { method: 'DELETE' }).catch(() => undefined);
    expect((await call('/api/magic-prompts')).status).toBe(200);
  });

  it('rejects invalid ids or text and removes every override', async () => {
    await put('/api/magic-prompts/valid_id.1', { text: 'a' });
    for (const path of ['/api/magic-prompts/BAD', '/api/magic-prompts/' + 'x'.repeat(161)]) {
      const response = await put(path, { text: 'a' });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid magic prompt id' });
    }
    const empty = await put('/api/magic-prompts/empty', { text: '' });
    expect(empty.status).toBe(400);
    const noText = await put('/api/magic-prompts/missing-text', {});
    expect(noText.status).toBe(400);
    const malformed = await call('/api/magic-prompts/valid', { method: 'PUT', body: 'oops' });
    expect(malformed.status).toBe(400);

    await put('/api/magic-prompts/all.reset', { text: 'first' });
    const clearAll = await call('/api/magic-prompts', { method: 'DELETE' });
    expect(await clearAll.json()).toEqual({ version: 1, overrides: {} });

    const missingOne = await call('/api/magic-prompts/all.reset', { method: 'DELETE' });
    expect(missingOne.status).toBe(404);
    expect(await missingOne.json()).toEqual({ error: 'magic prompt not found' });
  });
});
