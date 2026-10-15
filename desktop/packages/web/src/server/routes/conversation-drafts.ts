// SPDX-License-Identifier: Apache-2.0
import { readFile, mkdir, writeFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { ENV } from '../env.ts';
import { withConfigLock } from '../scheduled/config-lock.ts';
import { readJsonBodyBounded } from '../lib/http/read-bounded.ts';

type DraftValue = { metadata: { id: string; directory: string; title: string; createdAt: number; model: unknown; reviewMode: string }; content: { text: string; attachments: unknown[]; queue: unknown[]; updatedAt: number } };
type Row = { revision: number; value: DraftValue | null };
type Document = { version: 1; revision: number; drafts: Record<string, Row> };
const ID = /^draft_[a-f0-9-]{36}$/u;
const BODY_LIMIT = 24_000_000, FILE_LIMIT = 64_000_000;
function validValue(value: unknown, id: string): value is DraftValue {
  const row = value as DraftValue | null, meta = row?.metadata, content = row?.content;
  return Boolean(meta && meta.id === id && typeof meta.directory === 'string' && meta.directory.length > 0 && meta.directory.length <= 4096
    && typeof meta.title === 'string' && meta.title.length <= 120 && Number.isSafeInteger(meta.createdAt) && meta.createdAt >= 0
    && ['auto-review', 'unattended'].includes(meta.reviewMode)
    && (meta.model === null || typeof (meta.model as { providerID?: unknown })?.providerID === 'string' && typeof (meta.model as { modelID?: unknown })?.modelID === 'string')
    && content && typeof content.text === 'string' && content.text.length <= 1_000_000
    && Array.isArray(content.attachments) && content.attachments.length <= 16 && Array.isArray(content.queue) && content.queue.length <= 64
    && Number.isSafeInteger(content.updatedAt) && content.updatedAt >= 0);
}
async function read(path: string): Promise<Document> {
  try {
    const info = await stat(path); if (!info.isFile() || info.size > FILE_LIMIT) throw new Error('Draft storage exceeds its limit');
    const value = JSON.parse(await readFile(path, 'utf8')) as Document;
    if (value?.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !value.drafts || Array.isArray(value.drafts)
      || Object.keys(value.drafts).length > 192 || !Object.entries(value.drafts).every(([id, row]) => ID.test(id) && Number.isSafeInteger(row?.revision) && row.revision > 0 && row.revision <= value.revision && (row.value === null || validValue(row.value, id)))) throw new Error('Draft storage is invalid');
    return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, revision: 0, drafts: {} }; throw error; }
}
/** Authenticated draft bytes confer no native workspace or execution authority. */
export function registerConversationDraftRoutes(app: Hono): void {
  const file = () => join(ENV.dataDir, 'conversation-drafts.json');
  app.get('/api/conversation-drafts', async context => context.json(await read(file())));
  app.post('/api/conversation-drafts', async context => {
    const body = await readJsonBodyBounded(context.req.raw, BODY_LIMIT);
    if (!body || typeof body.id !== 'string' || !ID.test(body.id) || !Number.isSafeInteger(body.expected_revision) || Number(body.expected_revision) < 0 || !(body.value === null || validValue(body.value, body.id))) return context.json({ error: 'Conversation draft is invalid or too large.' }, 400);
    const id = body.id, value = body.value as DraftValue | null;
    const result = await withConfigLock(file(), async () => {
      const document = await read(file()), prior = document.drafts[id];
      if ((prior?.revision ?? 0) !== body.expected_revision) return null;
      if (value && !prior?.value && Object.values(document.drafts).filter(row => row.value).length >= 64) throw new Error('Conversation draft limit reached');
      document.revision += 1; document.drafts[id] = { revision: document.revision, value };
      const deleted = Object.entries(document.drafts).filter(([, row]) => row.value === null).sort((a, b) => b[1].revision - a[1].revision);
      for (const [old] of deleted.slice(128)) delete document.drafts[old];
      const bytes = JSON.stringify(document); if (Buffer.byteLength(bytes) > FILE_LIMIT) throw new Error('Draft storage exceeds its limit');
      await mkdir(ENV.dataDir, { recursive: true }); const temporary = `${file()}.${randomUUID()}.tmp`;
      await writeFile(temporary, bytes, { encoding: 'utf8', mode: 0o600 }); await rename(temporary, file());
      return document.drafts[id];
    });
    return result ? context.json(result) : context.json({ error: 'This draft changed in another window. Reopen it before saving.' }, 409);
  });
}
