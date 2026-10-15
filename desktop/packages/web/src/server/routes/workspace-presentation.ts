// SPDX-License-Identifier: Apache-2.0
import { readFile, mkdir, writeFile, rename, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { ENV } from '../env.ts';
import { withConfigLock } from '../scheduled/config-lock.ts';
import { readJsonBodyBounded } from '../lib/http/read-bounded.ts';

type WorkspaceDisplay = { label: string; hidden: boolean };
type Preference = { revision: number; value: string };
type Document = { version: 1; workspaces: Record<string, WorkspaceDisplay>; preferences?: Record<string, Preference> };
const PREFERENCE = /^(?:sidebar\.(?:width|sort|group|archive|collapsed|workspace-order)|pins)$/u;
const ID = /^ws_[a-f0-9]{24}$/u;
const defaultDirectory = () => resolve(process.env.NNA_HOME || resolve(homedir(), '.nna'), 'workspace');
function validRow(value: unknown): value is WorkspaceDisplay {
  const row = value as WorkspaceDisplay | null;
  return Boolean(row && typeof row.label === 'string' && row.label.length <= 120
    && !/[\u0000-\u001f]/u.test(row.label) && typeof row.hidden === 'boolean');
}
async function read(path: string): Promise<Document> {
  let source: string;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 128_000) throw new Error('Workspace display storage exceeds its limit');
    source = await readFile(path, 'utf8');
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, workspaces: {} }; throw error; }
  if (source.length > 128_000) throw new Error('Workspace display storage exceeds its limit');
  const value = JSON.parse(source) as Document;
  if (value?.version !== 1 || !value.workspaces || Array.isArray(value.workspaces)
    || Object.keys(value.workspaces).length > 256
    || !Object.entries(value.workspaces).every(([id, row]) => ID.test(id) && validRow(row))) {
    throw new Error('Workspace display storage is invalid');
  }
  if (value.preferences && (Array.isArray(value.preferences) || Object.keys(value.preferences).length > 7 || !Object.entries(value.preferences).every(([key, row]) => PREFERENCE.test(key) && Number.isSafeInteger(row?.revision) && row.revision > 0 && typeof row.value === 'string' && row.value.length <= 32768))) throw new Error('Sidebar preferences are invalid');
  return value;
}
async function persist(path: string, document: Document): Promise<void> {
  const source = JSON.stringify(document); if (Buffer.byteLength(source) > 128_000) throw new Error('Workspace display storage exceeds its limit');
  await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, source, { encoding: 'utf8', mode: 0o600 }); await rename(temporary, path);
}

/** Presentation metadata is independent of native workspace admission and session ownership. */
export function registerWorkspacePresentationRoutes(app: Hono): void {
  const file = () => join(ENV.dataDir, 'workspace-presentation.json');
  app.get('/api/workspace-presentation', async context => context.json({ ...await read(file()), default_directory: defaultDirectory() }));
  app.get('/api/workspace-preferences', async context => context.json((await read(file())).preferences ?? {}));
  app.post('/api/workspace-preferences', async context => {
    const body = await readJsonBodyBounded(context.req.raw, 40_000);
    if (!body || typeof body.key !== 'string' || !PREFERENCE.test(body.key) || typeof body.value !== 'string' || body.value.length > 32768 || !Number.isSafeInteger(body.expected_revision) || Number(body.expected_revision) < 0) return context.json({ error: 'Sidebar preference is invalid.' }, 400);
    const key = body.key, value = body.value, path = file();
    const result = await withConfigLock(path, async () => {
      const document = await read(path), preferences = document.preferences ?? {};
      const revision = preferences[key]?.revision ?? 0; if (revision !== body.expected_revision) return null;
      preferences[key] = { revision: revision + 1, value }; document.preferences = preferences;
      await persist(path, document); return preferences[key];
    });
    return result ? context.json(result) : context.json({ error: 'Sidebar preference changed in another window. Reload to use the saved choice.' }, 409);
  });
  app.post('/api/workspace-presentation', async context => {
    const body = await readJsonBodyBounded(context.req.raw, 2048);
    const id = body?.id;
    if (!body || typeof id !== 'string' || !ID.test(id) || !validRow(body)) {
      return context.json({ error: 'Workspace name or visibility is invalid.' }, 400);
    }
    const path = file();
    const updated = await withConfigLock(path, async () => {
      const document = await read(path);
      if (!document.workspaces[id] && Object.keys(document.workspaces).length >= 256) throw new Error('Workspace display limit reached');
      document.workspaces[id] = { label: String(body.label).trim(), hidden: Boolean(body.hidden) };
      await persist(path, document);
      return document;
    });
    return context.json({ ...updated, default_directory: defaultDirectory() });
  });
}
