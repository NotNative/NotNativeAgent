// SPDX-License-Identifier: Apache-2.0
/** P10-62 §G.6 verifier and raw integration tests for markdown image grants. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { registerMarkdownImageGrantRoutes } from '../routes/markdown-image-grants.ts';
import { registerFsReadRoutes } from '../routes/fs-read.ts';
import { mintOutsideFileGrant, resolveOutsideFileGrant } from '../lib/fs/outside-file-grants.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
let workspace: string;
let outside: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'nnd-workspace-'));
  outside = await mkdtemp(join(tmpdir(), 'nnd-outside-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('markdown image grants', () => {
  it('prepares referenced workspace and outside images with a raw-only grant', async () => {
    await writeFile(join(workspace, 'inside.png'), PNG);
    const outsidePath = join(outside, 'outside.png');
    await writeFile(outsidePath, PNG);
    const app = new Hono();
    const messageId = 'message-1';
    registerMarkdownImageGrantRoutes(app, {
      readMessages: async () => [assistantMessage(messageId,
        `![inside](inside.png) and ![outside](${filePath(outsidePath)}) and ![absent](absent.png)`)],
    });
    registerFsReadRoutes(app);
    const response = await app.request('/api/openchamber/sessions/session-1/markdown-image-grants', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId, directory: workspace, sources: ['inside.png', filePath(outsidePath), 'absent.png', 'unreferenced.png'] }),
    });
    expect(response.status).toBe(200);
    const result = await response.json() as { results: Array<Record<string, unknown>> };
    const results = result.results;
    expect(results).toEqual([
      expect.objectContaining({ source: 'inside.png', status: 'ready' }),
      expect.objectContaining({ source: filePath(outsidePath), status: 'ready' }),
      { source: 'absent.png', status: 'missing' },
      { source: 'unreferenced.png', status: 'error' },
    ]);
    const insideReady = results[0] as { path?: string; outsideFileGrant?: string };
    const outsideReady = results[1] as { path?: string; outsideFileGrant?: string; expiresAt?: number };
    expect(insideReady.path).toBe(join(workspace, 'inside.png'));
    expect(insideReady.outsideFileGrant).toBeUndefined();
    expect(typeof outsideReady.outsideFileGrant).toBe('string');
    expect(outsideReady.expiresAt).toBeGreaterThan(Date.now());

    const grant = `${outsideReady.outsideFileGrant}`;
    expect(resolveOutsideFileGrant(grant, `${outsideReady.path}`)).toEqual({ path: outsideReady.path, expiresAt: outsideReady.expiresAt });
    expect(resolveOutsideFileGrant(grant, join(workspace, 'inside.png'))).toBeNull();
    const valid = await app.request(`/api/fs/raw?path=${encodeURIComponent(`${outsideReady.path}`)}&allowOutsideWorkspace=true&outsideFileGrant=${encodeURIComponent(grant)}`);
    expect(valid.status).toBe(200);
    expect(Buffer.from(await valid.arrayBuffer())).toEqual(PNG);
    await writeFile(outsidePath, Buffer.from('not-image'));
    const swapped = await app.request('/api/fs/raw?path=' + encodeURIComponent(String(outsideReady.path)) + '&allowOutsideWorkspace=true&outsideFileGrant=' + encodeURIComponent(grant));
    expect(swapped.status).toBe(415);
    const reused = await app.request(`/api/fs/raw?path=${encodeURIComponent(join(workspace, 'inside.png'))}&allowOutsideWorkspace=true&outsideFileGrant=${encodeURIComponent(grant)}`);
    expect(reused.status).toBe(403);
  });

  it('bounds the in-memory raw grant store', () => {
    const first = mintOutsideFileGrant('/bounded/first.png');
    for (let index = 0; index < 1024; index += 1) mintOutsideFileGrant(`/bounded/${index}.png`);
    expect(resolveOutsideFileGrant(first?.token ?? '', '/bounded/first.png')).toBeNull();
    const latest = mintOutsideFileGrant('/bounded/latest.png');
    expect(latest && (resolveOutsideFileGrant(latest.token, latest.path) !== null)).toBe(true);
  });
  it('rejects assistant messages and malformed grant requests', async () => {
    const app = new Hono();
    const messages: unknown[] = [];
    registerMarkdownImageGrantRoutes(app, { readMessages: async () => messages });
    const missing = await app.request('/api/openchamber/sessions/session-1/markdown-image-grants', {
      method: 'POST',
      body: JSON.stringify({ messageId: 'm', directory: workspace, sources: ['a.png'] }),
    });
    expect(missing.status).toBe(404);
    messages.push(assistantMessage('m', '![](wrong.png)'));
    const user = assistantMessage('wrong', '![](right.png)');
    (user.info as Record<string, unknown>).role = 'user';
    messages.push(user);
    const wrongMessage = await app.request('/api/openchamber/sessions/session-1/markdown-image-grants', {
      method: 'POST',
      body: JSON.stringify({ messageId: 'wrong', directory: workspace, sources: ['right.png'] }),
    });
    expect(wrongMessage.status).toBe(404);
    const noSources = await app.request('/api/openchamber/sessions/session-1/markdown-image-grants', {
      method: 'POST',
      body: JSON.stringify({ messageId: 'm', directory: workspace, sources: [] }),
    });
    expect(noSources.status).toBe(400);
  });
});

function filePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function assistantMessage(id: string, text: string): {
  info: Record<string, unknown>;
  parts: Record<string, unknown>[];
} {
  return { info: { id, role: 'assistant' }, parts: [{ type: 'text', text }] };
}
