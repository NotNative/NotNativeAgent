// SPDX-License-Identifier: Apache-2.0
// Durable identity for OpenCode wire sessions.
//
// Why: every OpenChamber session runs a real durable engine, but the wire id
// (`ses_*`) was minted per process, so a restart reopened every conversation
// under a fresh engine id and the GUI lost its history. The engine already
// restores itself when opened with an existing journal id
// (`restoreDurableEngine`), so the only missing link is a durable
// `ocId → session_*` mapping plus the descriptive fields the registry needs.
// This index is that link: one NDJSON file in the store root, appended per
// session, replayed at boot.
//
// Security: the index holds identity and descriptive fields only — no
// transcript content, no credentials, no workspace contents.
import { appendFile, open, readFile, readdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';

const INDEX_FILE = 'opencode-sessions.ndjson';
const SCHEMA = 'nna.opencode-session-index.v1';
const MAX_INDEX_BYTES = 1_048_576;
const MAX_INDEX_ENTRIES = 512;

export async function appendSessionIndex(storeRoot, record) {
  // Why a dedupe instead of a blind append: a session re-attaches through the same
  // creation path at boot restore, so a blind append wrote the same identity twice
  // per restore. The reader already compacts to newest-per-id, but a file that grows
  // by two lines per boot misstates what it holds; write the identity once.
  const records = await readSessionIndex(storeRoot);
  const existing = records.findIndex((entry) => entry.ocId === record.ocId);
  if (existing >= 0) {
    await rewriteIndex(storeRoot, records.map((entry, index) => index === existing ? { ...entry, ...record } : entry));
    return;
  }
  await appendFile(join(storeRoot, INDEX_FILE), `${JSON.stringify({ schema: SCHEMA, ...record })}\n`, { encoding: 'utf8' });
}

export async function removeSessionIndex(storeRoot, ocId) {
  const records = await readSessionIndex(storeRoot);
  const kept = records.filter((record) => record.ocId !== ocId);
  if (kept.length === records.length) return;
  await rewriteIndex(storeRoot, kept);
}

export async function updateSessionIndex(storeRoot, ocId, patch) {
  const records = await readSessionIndex(storeRoot);
  const index = records.findIndex((record) => record.ocId === ocId);
  if (index < 0) return;
  records[index] = { ...records[index], ...patch, ocId };
  await rewriteIndex(storeRoot, records);
}

/** Read the compacted index: newest record per ocId, bounded scan.
 *  A torn trailing append is skipped, not fatal; earlier records stand. */
export async function readSessionIndex(storeRoot) {
  let content;
  try { content = await readFile(join(storeRoot, INDEX_FILE), 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  if (content.length > MAX_INDEX_BYTES) {
    // Invariant: an unbounded index would slow every boot; compact in place
    // and answer from what was readable before the rewrite.
    const compacted = compactLines(content);
    await rewriteIndex(storeRoot, compacted);
    return compacted;
  }
  return compactLines(content);
}

function compactLines(content) {
  const byId = new Map();
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (validRecord(record)) byId.set(record.ocId, record);
    } catch { /* a torn trailing append is skipped; earlier records stand. */ }
  }
  return [...byId.values()].slice(-MAX_INDEX_ENTRIES);
}

function rewriteIndex(storeRoot, records) {
  // Why raw and not `persistAtomicJson`: that helper JSON-stringifies its
  // value, which would double-encode this NDJSON body into one string literal
  // no reader could parse. The swap below is the same temp+rename discipline.
  return atomicTextWrite(join(storeRoot, INDEX_FILE),
    records.map((record) => `${JSON.stringify({ schema: SCHEMA, ...record })}`).join('\n') + (records.length ? '\n' : ''));
}

async function atomicTextWrite(path, content) {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(content, 'utf8'); await handle.sync(); }
  finally { await handle.close().catch(() => undefined); }
  await rename(temporary, path);
}

function validRecord(record) {
  return record !== null && typeof record === 'object'
    && typeof record.ocId === 'string' && record.ocId.startsWith('ses_')
    && typeof record.sessionId === 'string' && record.sessionId.startsWith('session_');
}

/** The name a deleted session's journal takes. Why a rename and not a delete:
 *  the engine's recovery semantics keep journal content on disk; discovery just
 *  must never re-adopt a conversation the operator explicitly deleted. */
export function tombstoneJournalName(sessionId) {
  return `${sessionId}.journal.deleted`;
}

/** Journals in the store root that no index entry claims.
 *
 *  Why discovery: sessions created before the index existed left durable
 *  journals with no ocId recorded. They are restored under a fresh wire id so
 *  the history is reachable, and the re-attach writes them back into the index
 *  so the next boot needs no scan.
 *
 *  Security: a journal is only observed here (first record, mtime); opening a
 *  journal for replay stays the engine's job behind its own session lock. */
export async function discoverUnindexedSessions(storeRoot, knownSessionIds) {
  const known = new Set(knownSessionIds);
  let names;
  try { names = await readdir(storeRoot); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const discovered = [];
  for (const name of names) {
    if (!name.endsWith('.journal.ndjson')) continue;
    const sessionId = name.slice(0, -'.journal.ndjson'.length);
    if (!sessionId.startsWith('session_') || known.has(sessionId)) continue;
    const path = join(storeRoot, name);
    try {
      const created = await readJournalFirstRecord(path);
      if (!created) continue;
      discovered.push({ sessionId, createdAt: (await stat(path)).mtimeMs, workspaceRoot: created.workspaceRoot });
    } catch { /* an unreadable journal is skipped, never force-opened. */ }
  }
  return discovered;
}

async function readJournalFirstRecord(path) {
  const handle = await open(path, 'r');
  try {
    // Why the explicit buffer: a supplied buffer makes `read` fill it without
    // returning a `value`, so the first line must be cut from the buffer itself.
    const buffer = Buffer.alloc(65_536);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const record = JSON.parse(buffer.toString('utf8', 0, bytesRead).split('\n', 1)[0]);
    if (record.type !== 'session_created') return null;
    const payload = record.payload ?? {};
    return { workspaceRoot: typeof payload.workspaceRoot === 'string' ? payload.workspaceRoot : null };
  } finally { await handle.close().catch(() => undefined); }
}
