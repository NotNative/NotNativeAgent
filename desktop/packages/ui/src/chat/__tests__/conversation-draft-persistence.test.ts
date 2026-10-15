// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runtimeFetch } from '../../lib/runtime-fetch.ts';
import { connectConversationDraftPersistence, disconnectConversationDraftPersistence, flushConversationDraftPersistence, removePersistedConversationDraft, type SavedConversationDraft } from '../conversation-draft-persistence.ts';
vi.mock('../../lib/runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));
vi.mock('../../lib/runtime-switch.ts', () => ({ getRuntimeKey: () => 'same-native-data' }));
const id = 'draft_' + 'a'.repeat(36);
const draft = (): SavedConversationDraft => ({ metadata: { id, directory: 'D:/work', title: 'Draft', createdAt: 1, model: { providerID: 'local', modelID: 'model' }, reviewMode: 'unattended' }, content: { text: 'Saved before restart', attachments: [{ name: 'proof.txt', mime: 'text/plain', dataUrl: 'data:text/plain;base64,aGVsbG8=' }], queue: [], projectContextPins: { notes: [], plans: [] }, updatedAt: 1 } });
let rows: Record<string, { revision: number; value: SavedConversationDraft | null }>, serial: number;
beforeEach(() => {
  serial = 0; rows = {};
  vi.mocked(runtimeFetch).mockImplementation(async (_path, init) => {
    if (!init || init.method === 'GET') return new Response(JSON.stringify({ version: 1, drafts: rows }));
    const body = JSON.parse(String(init.body));
    if (body.expected_revision !== (rows[body.id]?.revision ?? 0)) return new Response(JSON.stringify({ error: 'Draft changed in another window.' }), { status: 409 });
    const row = { revision: ++serial, value: body.value }; rows[body.id] = row; return new Response(JSON.stringify(row));
  });
});
afterEach(disconnectConversationDraftPersistence);
it('recovers prompt, attachments and choices without any previous browser storage', async () => {
  let local = [draft()]; const error = vi.fn();
  await connectConversationDraftPersistence({ snapshot: () => local, restore: values => { local = values; }, error });
  expect(rows[id]!.value).toEqual(draft()); disconnectConversationDraftPersistence(); local = [];
  await connectConversationDraftPersistence({ snapshot: () => local, restore: values => { local = values; }, error });
  expect(local).toEqual([draft()]);
  await removePersistedConversationDraft(id); local = []; disconnectConversationDraftPersistence();
  await connectConversationDraftPersistence({ snapshot: () => local, restore: values => { local = values; }, error }); expect(local).toEqual([]);
});
it('refuses a conflicting save and retains the local draft for recovery', async () => {
  let local = [draft()]; const error = vi.fn(); await connectConversationDraftPersistence({ snapshot: () => local, restore: values => { local = values; }, error });
  rows[id]!.revision = ++serial;
  local = [{ ...draft(), content: { ...draft().content, text: 'Local edit' } }];
  await expect(flushConversationDraftPersistence()).rejects.toThrow('Draft changed in another window');
  expect(local[0]!.content.text).toBe('Local edit'); expect(rows[id]!.value!.content.text).toBe('Saved before restart'); expect(error).toHaveBeenLastCalledWith('Draft changed in another window.');
});
it('discards a hydrate response after its connection is replaced', async () => {
  let settle!: (response: Response) => void; vi.mocked(runtimeFetch).mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
  const restore = vi.fn(); const loading = connectConversationDraftPersistence({ snapshot: () => [], restore, error: vi.fn() });
  disconnectConversationDraftPersistence(); settle(new Response(JSON.stringify({ version: 1, drafts: { [id]: { revision: 1, value: draft() } } }))); await loading; expect(restore).not.toHaveBeenCalled();
});
