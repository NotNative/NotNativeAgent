// SPDX-License-Identifier: Apache-2.0
import { beforeAll, afterAll, expect, it } from 'vitest';
import { Hono } from 'hono';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENV } from '../env.ts';
import { registerConversationDraftRoutes } from '../routes/conversation-drafts.ts';
let scratch: string; const previous = ENV.dataDir;
const make = () => { const app = new Hono(); registerConversationDraftRoutes(app); return app; };
const app = make();
beforeAll(async () => { scratch = await mkdtemp(join(tmpdir(), 'nnd-conversation-drafts-')); (ENV as { dataDir: string }).dataDir = scratch; });
afterAll(async () => { (ENV as { dataDir: string }).dataDir = previous; await rm(scratch, { recursive: true, force: true }); });
const a = 'draft_' + 'a'.repeat(36), b = 'draft_' + 'b'.repeat(36);
const value = (id: string, text = 'Retained prompt') => ({ metadata: { id, directory: 'D:/workspace', title: 'Draft', createdAt: 1, model: { providerID: 'local', modelID: 'test' }, reviewMode: 'unattended' }, content: { text, attachments: [{ name: 'proof.txt', mime: 'text/plain', dataUrl: 'data:text/plain;base64,aGVsbG8=' }], queue: [], updatedAt: 1 } });
const save = (id: string, expected_revision: number, row: unknown) => app.request('/api/conversation-drafts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, expected_revision, value: row }) });
it('retains independent drafts across route recreation and refuses concurrent overwrite', async () => {
  const created = await Promise.all([save(a, 0, value(a)), save(b, 0, value(b))]); expect(created.map(row => row.status)).toEqual([200, 200]);
  const first = await created[0]!.json() as { revision: number };
  const race = await Promise.all([save(a, first.revision, value(a, 'One')), save(a, first.revision, value(a, 'Two'))]);
  expect(race.map(row => row.status).sort()).toEqual([200, 409]);
  const recovered = await (await make().request('/api/conversation-drafts')).json() as { drafts: Record<string, { value: ReturnType<typeof value> }> };
  expect(recovered.drafts[b]!.value).toEqual(value(b));
});
it('keeps deletion receipts and rejects a delayed save from another window', async () => {
  const document = await (await app.request('/api/conversation-drafts')).json() as { drafts: Record<string, { revision: number }> };
  const revision = document.drafts[a]!.revision;
  expect((await save(a, revision, null)).status).toBe(200);
  expect((await save(a, revision, value(a))).status).toBe(409);
  const recovered = await (await make().request('/api/conversation-drafts')).json() as { drafts: Record<string, { value: unknown }> };
  expect(recovered.drafts[a]!.value).toBeNull();
  expect((await save('invalid', 0, value(a))).status).toBe(400);
});
it('preserves corrupt draft evidence instead of overwriting it', async () => {
  const file = join(scratch, 'conversation-drafts.json'); await writeFile(file, '{broken');
  expect((await save(a, 0, value(a))).status).toBe(500); expect(await readFile(file, 'utf8')).toBe('{broken');
});
