// SPDX-License-Identifier: Apache-2.0
import { runtimeFetch } from '../lib/runtime-fetch.ts';
import { getRuntimeKey } from '../lib/runtime-switch.ts';
import type { ConversationDraft } from '../stores/useConversationDraftStore.ts';
import type { DraftRecord } from './drafts.ts';
export type SavedConversationDraft = { metadata: ConversationDraft; content: DraftRecord };
type Row = { revision: number; value: SavedConversationDraft | null };
type Ports = { snapshot: () => SavedConversationDraft[]; restore: (values: SavedConversationDraft[]) => void; error: (message: string | null) => void; saving?: (value: boolean) => void };
let epoch = 0;
let bridge: { ports: Ports; runtime: string; epoch: number; pending: number; revisions: Map<string, number>; written: Map<string, string> } | null = null;
let writes: Promise<void> = Promise.resolve();
let timer: ReturnType<typeof setTimeout> | null = null;
const valid = (owner: NonNullable<typeof bridge>) => bridge === owner && owner.epoch === epoch && owner.runtime === getRuntimeKey();
async function responseJson(response: Response) {
  const body = await response.json(); if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : 'Conversation drafts could not be saved.'); return body;
}
export function hasConversationDraftPersistence(): boolean { return bridge !== null && valid(bridge); }
export function disconnectConversationDraftPersistence(): void {
  epoch += 1; bridge = null; if (timer) clearTimeout(timer); timer = null;
}
export async function connectConversationDraftPersistence(ports: Ports): Promise<void> {
  disconnectConversationDraftPersistence(); const opening = epoch, runtime = getRuntimeKey();
  const document = await responseJson(await runtimeFetch('/api/conversation-drafts', { method: 'GET', signal: AbortSignal.timeout(30_000) })) as { version: number; drafts: Record<string, Row> };
  if (opening !== epoch || runtime !== getRuntimeKey()) return;
  if (document.version !== 1 || !document.drafts || Array.isArray(document.drafts)) throw new Error('Saved conversation drafts are invalid.');
  const values = new Map(ports.snapshot().map(row => [row.metadata.id, row]));
  const revisions = new Map<string, number>(), written = new Map<string, string>();
  for (const [id, row] of Object.entries(document.drafts)) {
    if (!/^draft_[a-f0-9-]{36}$/u.test(id) || !Number.isSafeInteger(row.revision) || row.revision < 1 || row.value && row.value.metadata?.id !== id) throw new Error('Saved conversation drafts are invalid.');
    revisions.set(id, row.revision);
    if (row.value) { values.set(id, row.value); written.set(id, JSON.stringify(row.value)); } else values.delete(id);
  }
  ports.restore([...values.values()].sort((a, b) => a.metadata.createdAt - b.metadata.createdAt));
  bridge = { ports, runtime, epoch: opening, pending: 0, revisions, written };
  await flushConversationDraftPersistence();
}
export function scheduleConversationDraftPersistence(): void {
  if (!bridge) return;
  bridge.ports.saving?.(true);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void flushConversationDraftPersistence().catch(() => undefined); }, 120);
}
function serialize(work: (owner: NonNullable<typeof bridge>) => Promise<void>): Promise<void> {
  const owner = bridge; if (!owner) return Promise.resolve();
  owner.pending += 1; owner.ports.saving?.(true);
  const operation = writes.catch(() => undefined).then(async () => { if (valid(owner)) { await work(owner); if (valid(owner)) owner.ports.error(null); } });
  writes = operation;
  return operation.catch(error => { if (valid(owner)) owner.ports.error(String(error instanceof Error ? error.message : error)); throw error; }).finally(() => { owner.pending -= 1; if (valid(owner) && owner.pending === 0 && !timer) owner.ports.saving?.(false); });
}
async function write(owner: NonNullable<typeof bridge>, id: string, value: SavedConversationDraft | null): Promise<void> {
  if (!valid(owner)) return;
  const row = await responseJson(await runtimeFetch('/api/conversation-drafts', { method: 'POST', signal: AbortSignal.timeout(30_000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, expected_revision: owner.revisions.get(id) ?? 0, value }) })) as Row;
  if (!valid(owner)) return;
  if (!Number.isSafeInteger(row.revision) || row.revision <= (owner.revisions.get(id) ?? 0)) throw new Error('Draft save receipt is invalid.');
  owner.revisions.set(id, row.revision); if (value) owner.written.set(id, JSON.stringify(value)); else owner.written.delete(id);
}
export function flushConversationDraftPersistence(): Promise<void> {
  if (timer) clearTimeout(timer); timer = null;
  return serialize(async owner => {
    for (const value of owner.ports.snapshot()) {
      if (!valid(owner)) return;
      if (owner.written.get(value.metadata.id) !== JSON.stringify(value)) await write(owner, value.metadata.id, value);
    }
  });
}
export async function removePersistedConversationDraft(id: string): Promise<void> {
  await flushConversationDraftPersistence();
  await serialize(owner => write(owner, id, null));
}
