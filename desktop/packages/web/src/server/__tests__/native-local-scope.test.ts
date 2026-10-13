// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Hono } from 'hono';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHarnessAdapter } from '../harness/adapter.ts';

let scratch = '', attached = '', other = '';
let harness: { harness: 'mock' | 'nna' };
let previousHarness: 'mock' | 'nna';
let registerScope: typeof import('../routes/native-local-scope.ts')['registerNativeLocalScope'];

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'nnd-native-git-scope-'));
  attached = join(scratch, 'attached').replaceAll('\\', '/');
  other = join(scratch, 'other').replaceAll('\\', '/');
  await mkdir(attached); await mkdir(other);
  harness = (await import('../env.ts')).ENV as { harness: 'mock' | 'nna' };
  previousHarness = harness.harness;
  harness.harness = 'nna';
  registerScope = (await import('../routes/native-local-scope.ts')).registerNativeLocalScope;
  registerHarnessAdapter({ handle: async request => {
    const path = new URL(request.url).pathname;
    if (path === '/api/path') return Response.json({ directory: attached, worktree: attached });
    if (path === '/api/v1/nnd/workspaces/admissions') return Response.json({
      selection_enabled: true, attached: { root: attached }, admitted: [],
    });
    throw new Error(`unexpected native request: ${path}`);
  } });
});
afterAll(async () => {
  harness.harness = previousHarness;
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

it('blocks an unadmitted Git query root before a read or mutation handler runs', async () => {
  const app = new Hono(); let calls = 0;
  registerScope(app);
  app.get('/api/git/status', () => { calls++; return Response.json({ ok: true }); });
  app.post('/api/git/commit', () => { calls++; return Response.json({ ok: true }); });
  for (const method of ['GET', 'POST']) {
    const path = method === 'GET' ? 'status' : 'commit';
    const response = await app.request(`/api/git/${path}?directory=${encodeURIComponent(other)}`, { method });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('not admitted');
  }
  expect(calls).toBe(0);
  const allowed = await app.request(`/api/git/status?directory=${encodeURIComponent(attached)}`);
  expect(allowed.status).toBe(200);
  expect(calls).toBe(1);
  const shifted = await app.request(`/api/git/status?directory=${encodeURIComponent(` ${attached}`)}`);
  expect(shifted.status).toBe(400);
  expect(calls).toBe(1);
  if (process.platform !== 'win32') {
    const backslash = await app.request(`/api/git/status?directory=${encodeURIComponent(attached.replaceAll('/', '\\'))}`);
    expect(backslash.status).toBe(400);
  }
});

it('checks the body directory on walkthrough generation before invoking the handler', async () => {
  const app = new Hono(); let calls = 0;
  registerScope(app);
  app.post('/api/git/walkthrough-generate', () => { calls++; return Response.json({ ok: true }); });
  const response = await app.request(`/api/git/walkthrough-generate?directory=${encodeURIComponent(attached)}`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ directory: other }),
  });
  expect(response.status).toBe(409);
  expect(calls).toBe(0);
});

it('blocks unadmitted file reads and writes before filesystem handlers run', async () => {
  const app = new Hono(); let calls = 0;
  registerScope(app);
  app.get('/api/fs/read', () => { calls++; return Response.json({ ok: true }); });
  app.post('/api/fs/write', () => { calls++; return Response.json({ ok: true }); });
  for (const method of ['GET', 'POST']) {
    const path = method === 'GET' ? 'read' : 'write';
    const response = await app.request(`/api/fs/${path}?directory=${encodeURIComponent(other)}`, { method });
    expect(response.status).toBe(409);
  }
  expect(calls).toBe(0);
});

it('runs the admission gate before the real app file routes', async () => {
  const { createApp } = await import('../app.ts');
  const app = createApp();
  const root = encodeURIComponent(other);
  const read = await app.fetch(new Request(`http://test.local/api/fs/list?directory=${root}&path=.`));
  expect(read.status).toBe(409);
  const target = join(other, 'blocked.txt');
  const write = await app.fetch(new Request(`http://test.local/api/fs/write?directory=${root}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'blocked.txt', content: 'must not write' }),
  }));
  expect(write.status).toBe(409);
  expect(existsSync(target)).toBe(false);
});
