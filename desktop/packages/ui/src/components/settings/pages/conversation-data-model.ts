// SPDX-License-Identifier: Apache-2.0
import { harnessClient, type HarnessSession } from '../../../lib/nnd/client.ts';
import type { MessageEntry } from '../../../lib/nnd/types.ts';
import { createDirectoryStore } from '../../../sync/child-store.ts';
import { sessionMarkdown } from '../../../chat/session-export.ts';

export async function readDataConversations(signal: AbortSignal): Promise<HarnessSession[]> {
  const result = await harnessClient.listSessions({ archived: true, limit: 1000, directory: '' });
  signal.throwIfAborted();
  if (result.error || !Array.isArray(result.data) || result.data.length > 1000 || result.data.some(row =>
    !row || typeof row.id !== 'string' || !row.id || typeof row.title !== 'string' || typeof row.directory !== 'string'
      || !Number.isFinite(row.time?.updated) || !Number.isFinite(row.time?.created))) throw new Error('The native conversation list is unavailable.');
  return result.data.filter(row => !row.parentID);
}

function checkEntries(entries: MessageEntry[], session: HarnessSession, ids: Set<string>) {
  if (entries.length > 100) throw new Error('Transcript page exceeds its supported bound.');
  for (const entry of entries) {
    if (!entry?.info || !entry.info.id || ids.has(entry.info.id) || entry.info.sessionID !== session.id
      || !['user', 'assistant'].includes(entry.info.role) || !Number.isFinite(entry.info.time?.created)
      || Math.abs(entry.info.time.created) > 8640000000000000 || !Array.isArray(entry.parts) || entry.parts.length > 4096)
      throw new Error('Transcript changed or contains an invalid record. Refresh before exporting.');
    ids.add(entry.info.id);
    if (entry.parts.some(part => !part || typeof part.type !== 'string'
      || part.type === 'text' && typeof part.text !== 'string')) throw new Error('Transcript contains an invalid text record.');
  }
}

async function requireIdle(session: HarnessSession, signal: AbortSignal) {
  const result = await harnessClient.sessionStatus({ directory: session.directory }); signal.throwIfAborted();
  if (result.error || !result.data || result.data[session.id]?.type && result.data[session.id]?.type !== 'idle')
    throw new Error('Could not confirm an idle conversation. Wait for its turn to finish before exporting.');
}

export async function conversationTranscript(session: HarnessSession, signal: AbortSignal): Promise<string> {
  await requireIdle(session, signal);
  const before = await harnessClient.getSession(session.id, { directory: session.directory });
  signal.throwIfAborted();
  if (before.error || before.data?.id !== session.id) throw new Error('Conversation is unavailable.');
  const entries: MessageEntry[] = [], ids = new Set<string>(), cursors = new Set<string>();
  let cursor: string | undefined, bytes = 0;
  for (let page = 0; page < 50; page += 1) {
    signal.throwIfAborted();
    const result = await harnessClient.listMessagesPage(session.id, { directory: session.directory, limit: 100, before: cursor });
    signal.throwIfAborted();
    if (result.error || !Array.isArray(result.data)) throw new Error('Transcript could not be read. No partial download was produced.');
    checkEntries(result.data, session, ids);
    bytes += new TextEncoder().encode(JSON.stringify(result.data)).byteLength;
    if (bytes > 8388608) throw new Error('Transcript exceeds the 8 MiB export bound. Use the native support export for larger evidence.');
    entries.unshift(...result.data);
    if (!result.cursor) {
      await requireIdle(session, signal);
      const after = await harnessClient.getSession(session.id, { directory: session.directory }); signal.throwIfAborted();
      if (after.error || after.data?.id !== session.id || before.data.time.updated !== after.data.time.updated)
        throw new Error('Conversation changed during export. Retry when its turn is idle.');
      const store = createDirectoryStore({ message: { [session.id]: entries.map(row => row.info) },
        part: Object.fromEntries(entries.map(row => [row.info.id, row.parts])) });
      return sessionMarkdown(store, session.id, session.title);
    }
    if (cursors.has(result.cursor)) throw new Error('Transcript cursor repeated. Refresh before exporting.');
    cursors.add(result.cursor); cursor = result.cursor;
  }
  throw new Error('Transcript exceeds the 50-page export bound. No partial download was produced.');
}
