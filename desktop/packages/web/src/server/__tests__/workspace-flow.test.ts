// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerWorkspaceBrowserRoutes } from '../routes/workspace-browser.ts';
import { registerWorkspacePresentationRoutes } from '../routes/workspace-presentation.ts';
import { ENV } from '../env.ts';
let scratch: string;
const previous = ENV.dataDir;
const app = new Hono();
registerWorkspaceBrowserRoutes(app); registerWorkspacePresentationRoutes(app);
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'nna-workspace-flow-'));
  (ENV as { dataDir: string }).dataDir = scratch;
  vi.stubEnv('NNA_HOME', scratch);
  await mkdir(join(scratch, 'Folder'));
  await writeFile(join(scratch, 'file.txt'), 'not a directory');
  await symlink(join(scratch, 'Folder'), join(scratch, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
});
afterAll(async () => { vi.unstubAllEnvs(); (ENV as { dataDir: string }).dataDir = previous; await rm(scratch, { recursive: true, force: true }); });
const browse = (path: string) => app.request(`/api/workspace-browser?path=${encodeURIComponent(path)}`);
const save = (id: string, label: string, hidden: boolean) => app.request('/api/workspace-presentation', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, label, hidden }),
});

it('browses directories without exposing files or following links', async () => {
  const response = await browse(scratch);
  expect(response.status).toBe(200);
  expect((await response.json() as { entries: { name: string }[] }).entries.map((row: { name: string }) => row.name)).toEqual(['Folder']);
  expect((await browse(join(scratch, 'alias'))).status).toBe(400);
  expect((await browse('relative')).status).toBe(400);
  expect((await browse(join(scratch, 'missing'))).status).toBe(400);
});

it('merges concurrent workspace names and visibility without changing files', async () => {
  const a = `ws_${'a'.repeat(24)}`, b = `ws_${'b'.repeat(24)}`;
  const responses = await Promise.all([save(a, 'Alpha', true), save(b, 'Beta', false)]);
  expect(responses.map(response => response.status)).toEqual([200, 200]);
  const document = await (await app.request('/api/workspace-presentation')).json() as { workspaces: unknown };
  expect(document.workspaces).toEqual({ [a]: { label: 'Alpha', hidden: true }, [b]: { label: 'Beta', hidden: false } });
  expect(await readFile(join(scratch, 'file.txt'), 'utf8')).toBe('not a directory');
  expect((await save('invalid', 'Invalid', false)).status).toBe(400);
});

it('prepares an idempotent default workspace under the selected data root', async () => {
  const first = await (await app.request('/api/workspace-default', { method: 'POST' })).json() as { directory: string };
  const second = await (await app.request('/api/workspace-default', { method: 'POST' })).json();
  expect(first.directory).toBe(join(scratch, 'workspace'));
  expect(second).toEqual(first);
});

it('persists sidebar choices independently of workspace names with revision checks', async () => {
  const update = (expected_revision: number, value: string) => app.request('/api/workspace-preferences', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'sidebar.width', expected_revision, value }) });
  expect((await update(0, '312')).status).toBe(200);
  expect((await update(0, '480')).status).toBe(409);
  const preferences = await (await app.request('/api/workspace-preferences')).json();
  expect(preferences).toMatchObject({ 'sidebar.width': { revision: 1, value: '312' } });
  const document = await (await app.request('/api/workspace-presentation')).json() as { workspaces: Record<string, unknown> };
  expect(Object.keys(document.workspaces)).toHaveLength(2);
});

it('refuses to replace a corrupt presentation document', async () => {
  const path = join(scratch, 'workspace-presentation.json');
  await writeFile(path, '{broken');
  expect((await save(`ws_${'a'.repeat(24)}`, 'Replacement', false)).status).toBe(500);
  expect(await readFile(path, 'utf8')).toBe('{broken');
});
