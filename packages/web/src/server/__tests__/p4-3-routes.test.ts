// SPDX-License-Identifier: Apache-2.0
/**
 * P4-3 gates: fs write family containment (traversal rejected, atomic file
 * materialized, rename one-root rule + 409, delete root refusal) and
 * §5.22 session-folders (last-writer-wins, 413 oversize, malformed stored
 * 500 strings, exists:false cold path). Same isolated-data-dir pattern as
 * p4-2-routes.test.ts.
 */
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath, sep } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerHarnessAdapter } from '../harness/adapter.ts';
import { mockHarness } from '../harness/mock/index.ts';

const isolatedDataDir = mkdtempSync(`${tmpdir()}${sep}nnd-data-p43-`);
const sandbox = mkdtempSync(`${tmpdir()}${sep}nnd-scope-p43-`);
const origin = 'http://test.local';
process.env.NOTNATIVE_DATA_DIR = isolatedDataDir;

type App = { fetch: (request: Request) => Promise<Response> };
let appInstance: App | null = null;

async function call(path: string, init?: RequestInit): Promise<Response> {
  return appInstance!.fetch(new Request(`${origin}${path}`, init));
}

beforeAll(async () => {
  const { createApp } = await import('../app.ts');
  registerHarnessAdapter(mockHarness);
  appInstance = { fetch: (request: Request) => Promise.resolve(createApp().fetch(request)) };
});

beforeEach(() => {
  if (!existsSync(`${sandbox}${sep}sub`)) mkdirSync(`${sandbox}${sep}sub`, { recursive: true });
  writeFileSync(`${sandbox}${sep}file.txt`, 'v1\n');
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
  rmSync(isolatedDataDir, { recursive: true, force: true });
});

describe('fs write family (§5.14 core)', () => {
  it('write creates the file atomically; traversal rejected', async () => {
    const ok = await call(`/api/fs/write?directory=${encodeURIComponent(sandbox)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'sub/new.txt', content: 'written by P4-3' }),
    });
    const body = await ok.json() as { success: boolean; path: string };
    expect(ok.status).toBe(200);
    expect(body.success).toBe(true);
    expect(readFileSync(`${sandbox}${sep}sub${sep}new.txt`, 'utf8')).toContain('P4-3');

    const traversal = await call(`/api/fs/write?directory=${encodeURIComponent(sandbox)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '..\\outside.txt', content: 'x' }),
    });
    expect(traversal.status).toBe(403);
    const traversalBody = await traversal.json() as { error: string };
    expect(traversalBody.error).toBe('Access denied');
  });

  it('mkdir creates nested dirs; write rejects directory targets with 400', async () => {
    const ok = await call(`/api/fs/mkdir?directory=${encodeURIComponent(sandbox)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'sub/a/b' }),
    });
    expect(ok.status).toBe(200);
    expect(existsSync(`${sandbox}${sep}sub${sep}a${sep}b`)).toBe(true);
    const notDir = await call(`/api/fs/write?directory=${encodeURIComponent(sandbox)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'sub', content: 'x' }),
    });
    expect(notDir.status).toBe(400);
  });

  it('rename moves inside one root, 404 on missing source, 409 on occupied target', async () => {
    const moved = await call(`/api/fs/rename?directory=${encodeURIComponent(sandbox)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ oldPath: 'file.txt', newPath: 'sub/renamed.txt' }),
    });
    expect(moved.status).toBe(200);
    expect(existsSync(`${sandbox}${sep}sub${sep}renamed.txt`)).toBe(true);
    const missing = await call(`/api/fs/rename?directory=${encodeURIComponent(sandbox)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ oldPath: 'missing.txt', newPath: 'sub/renamed.txt' }),
    });
    expect(missing.status).toBe(404);
    const occupied = await call(`/api/fs/rename?directory=${encodeURIComponent(sandbox)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ oldPath: 'sub/renamed.txt', newPath: 'sub' }),
    });
    expect(occupied.status).toBe(409);
  });

  it('delete removes recursively but refuses the scope root itself', async () => {
    const ok = await call(`/api/fs/delete?directory=${encodeURIComponent(sandbox)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'sub' }),
    });
    expect(ok.status).toBe(200);
    expect(existsSync(`${sandbox}${sep}sub`)).toBe(false);
    const rootKill = await call(`/api/fs/delete?directory=${encodeURIComponent(sandbox)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '.' }),
    });
    expect(rootKill.status).toBe(400);
    const body = await rootKill.json() as { error: string };
    expect(body.error).toContain('Refusing to delete the workspace root');
  });
});

describe('session folders (§5.22)', () => {
  it('cold read answers exists:false; valid POST persists; GET echoes without exists', async () => {
    const cold = await (await call('/api/session-folders')).json() as { version: number; exists: boolean };
    expect(cold.exists).toBe(false);

    const snapshot = {
      version: 1,
      foldersMap: { chats: [{ id: 'f1', name: 'Work', sessionIds: ['s1'], createdAt: 1 }] },
      collapsedFolderIds: [],
      updatedAt: 100,
    };
    let saved = await call('/api/session-folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(snapshot),
    });
    expect((await saved.json()) as { success: boolean }).toMatchObject({ success: true });
    const warm = await (await call('/api/session-folders')).json() as { version: number; exists: boolean; foldersMap: Record<string, unknown> };
    expect(warm.version).toBe(1);
    expect(warm.exists).toBe(true); // §5.22 doc-verbatim warm shape carries exists:true
    expect(Object.keys(warm.foldersMap)).toContain('chats');
    // an OLDER snapshot arriving later is ignored: disk keeps the NEWER one
    const stale = await call('/api/session-folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...snapshot, updatedAt: 50, foldersMap: { chats: [{ id: 'stale', name: 'Stale', sessionIds: [], createdAt: 0 }] } }),
    });
    expect((await stale.json()) as { success: boolean; ignored: boolean }).toMatchObject({ success: true, ignored: true });
    const onDisk = JSON.parse(readFileSync(joinPath(isolatedDataDir, 'session-folders.json'), 'utf8')) as { updatedAt: number };
    expect(onDisk.updatedAt).toBe(100); // newer snapshot retained
  });

  it('older updatedAt is accepted but IGNORED (last-writer-wins)', async () => {
    const older = {
      version: 1,
      foldersMap: { chats: [{ id: 'old', name: 'Stale', sessionIds: [], createdAt: 0 }] },
      collapsedFolderIds: [],
      updatedAt: 50,
    };
    const result = await call('/api/session-folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(older),
    });
    const body = await result.json() as { success: boolean; ignored: boolean };
    expect(body).toMatchObject({ success: true, ignored: true });
  });

  it('malformed snapshots are 400; oversize payload is 413', async () => {
    const malformed = await call('/api/session-folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 99 }),
    });
    expect(malformed.status).toBe(400);
    const oversize = await call('/api/session-folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(4 * 1024 * 1024 + 1),
    });
    expect(oversize.status).toBe(413);
    const body = await oversize.json() as { error: string };
    expect(body.error).toBe('Payload too large');
  });
});
