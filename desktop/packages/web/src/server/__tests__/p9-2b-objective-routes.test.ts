// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { ObjectiveStore } from '../goals/objective-store.ts';
import { registerObjectiveRoutes } from '../goals/objective-routes.ts';

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture(): Promise<{ app: Hono; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'nnd-goal-objective-'));
  directories.push(directory);
  const app = new Hono();
  registerObjectiveRoutes(app, new ObjectiveStore(directory));
  return { app, directory };
}

async function call(app: Hono, path: string, method = 'GET', body?: unknown): Promise<Response> {
  return await app.request(`http://test.local${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('goal objective file routes (§B.1)', () => {
  it('writes, reads, live-edits, and best-effort deletes a bounded session objective', async () => {
    const { app, directory } = await fixture();
    const url = '/api/goals/objective/ses_valid_1';
    expect((await call(app, url)).status).toBe(404);
    const first = await (await call(app, url, 'PUT', { content: `  ${'x'.repeat(5_100)}  ` })).json() as { key: string };
    expect(first.key).toMatch(/^[a-f0-9]{64}$/);
    const content = ((await (await call(app, `${url}?key=${first.key}`)).json()) as { content: string }).content;
    expect(content).toHaveLength(5_000);
    expect(content).toBe('x'.repeat(5_000));
    expect(await readFile(join(directory, 'goals', `ses_valid_1.${first.key}.md`), 'utf8')).toBe(content);
    const second = await (await call(app, url, 'PUT', { content: ' revised ' })).json() as { key: string };
    expect(second.key).not.toBe(first.key);
    expect(await (await call(app, `${url}?key=${second.key}`)).json()).toEqual({ content: 'revised' });
    expect(await (await call(app, `${url}?key=${first.key}`)).json()).toEqual({ content });
    expect((await call(app, `${url}?key=${second.key}`, 'DELETE')).status).toBe(200);
    expect((await call(app, `${url}?key=${second.key}`, 'DELETE')).status).toBe(200);
    expect((await call(app, `${url}?key=${second.key}`)).status).toBe(404);
  });

  it('rejects malformed identifiers and content before touching storage', async () => {
    const { app, directory } = await fixture();
    for (const id of ['abc', 'bad.name', 'A'.repeat(129)]) {
      expect((await call(app, `/api/goals/objective/${id}`, 'PUT', { content: 'unsafe' })).status).toBe(400);
    }
    // WHATWG URL normalization removes a dot segment before Hono can match it.
    expect((await call(app, '/api/goals/objective/%2e%2e', 'PUT', { content: 'unsafe' })).status).toBe(404);
    const url = '/api/goals/objective/ses_valid_1';
    expect((await call(app, url, 'PUT', { content: '   ' })).status).toBe(400);
    expect((await call(app, url, 'PUT', { content: 12 })).status).toBe(400);
    expect((await call(app, url, 'PUT', { content: 'x'.repeat(33_000) })).status).toBe(413);
    expect((await call(app, url)).status).toBe(404);
    const result = await (await call(app, url, 'PUT', { content: 'safe' })).json() as { key: string };
    expect(await readFile(join(directory, 'goals', `ses_valid_1.${result.key}.md`), 'utf8')).toBe('safe');
  });

  it('refuses a symlinked objective on read and does not disclose its target', async () => {
    const { app, directory } = await fixture();
    const url = '/api/goals/objective/ses_valid_1';
    const result = await (await call(app, url, 'PUT', { content: 'safe' })).json() as { key: string };
    const privateFile = join(directory, 'private.txt');
    await writeFile(privateFile, 'private secret');
    const target = join(directory, 'goals', `ses_valid_1.${result.key}.md`);
    await rm(target);
    try { await symlink(privateFile, target, 'file'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return; // Windows without Developer Mode
      throw error;
    }
    const response = await call(app, `${url}?key=${result.key}`);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('private secret');
  });

  it('gives identical edits distinct generations, so a stale delete cannot remove a replacement', async () => {
    const { app } = await fixture();
    const url = '/api/goals/objective/ses_valid_1';
    const old = await (await call(app, url, 'PUT', { content: 'same text' })).json() as { key: string };
    const next = await (await call(app, url, 'PUT', { content: 'same text' })).json() as { key: string };
    expect(old.key).not.toBe(next.key);
    expect((await call(app, `${url}?key=${old.key}`, 'DELETE')).status).toBe(200);
    expect(await (await call(app, `${url}?key=${next.key}`)).json()).toEqual({ content: 'same text' });
    expect((await call(app, `${url}?key=../escape`)).status).toBe(400);
  });
});
