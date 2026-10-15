// SPDX-License-Identifier: Apache-2.0
import { readFile, mkdir, writeFile, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { ENV } from '../env.ts';
import { withConfigLock } from '../scheduled/config-lock.ts';
import { readJsonBodyBounded } from '../lib/http/read-bounded.ts';

type WorkspaceDisplay = { label: string; hidden: boolean };
type Document = { version: 1; workspaces: Record<string, WorkspaceDisplay> };
const ID = /^ws_[a-f0-9]{24}$/u;
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
  return value;
}

/** Presentation metadata is independent of native workspace admission and session ownership. */
export function registerWorkspacePresentationRoutes(app: Hono): void {
  const file = () => join(ENV.dataDir, 'workspace-presentation.json');
  app.get('/api/workspace-presentation', async context => context.json(await read(file())));
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
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(document), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, path);
      return document;
    });
    return context.json(updated);
  });
}
