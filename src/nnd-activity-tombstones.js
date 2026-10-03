// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { ContractError, requireExternalId } from './ids.js';
import { persistAtomicJson } from './persistence/atomic-json.js';
import { requirePrincipal } from './nnd-session-helpers.js';

export const TOMBSTONE_LIMIT = 256;
const FILE_LIMIT = 524_288;
const invalid = () => new ContractError('nnd_activity_tombstones_invalid', 'NND Activity tombstone journal is invalid');

function ownerKey(principal) {
  requirePrincipal(principal);
  const workspaceIds = [...new Set(principal.workspaceIds)].sort();
  return { subjectId: principal.subjectId, workspaceIds,
    digest: createHash('sha256').update(JSON.stringify([principal.subjectId, workspaceIds])).digest('hex') };
}

function journalPath(catalogPath, principal) {
  return join(`${catalogPath}.tombstones`, `${ownerKey(principal).digest}.json`);
}
function contextPrincipal(context) { return { subjectId: context.subjectId, workspaceIds: [...context.workspaceIds] }; }

function validEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  try { requireExternalId(entry.sessionId, 'session_id'); } catch { return false; }
  return Object.keys(entry).sort().join(',') === 'createdAt,deletedAt,sequence,sessionId,state'
    && Number.isSafeInteger(entry.createdAt) && entry.createdAt > 0
    && Number.isSafeInteger(entry.deletedAt) && entry.deletedAt > 0
    && Number.isSafeInteger(entry.sequence) && entry.sequence > 0
    && ['intent', 'deleted'].includes(entry.state);
}

async function readJournal(path, owner) {
  let source;
  try {
    const handle = await open(path, 'r');
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > FILE_LIMIT) throw invalid();
      const bytes = Buffer.alloc(metadata.size + 1); let size = 0;
      while (size < bytes.length) {
        const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
        if (bytesRead === 0) break;
        size += bytesRead;
      }
      if (size === bytes.length) throw invalid();
      source = bytes.subarray(0, size).toString('utf8');
    } finally { await handle.close(); }
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, subjectId: owner.subjectId,
      workspaceIds: owner.workspaceIds, nextSequence: 1, floor: 0, entries: [] };
    if (error.code === 'nnd_activity_tombstones_invalid') throw error;
    throw new ContractError('nnd_activity_tombstones_unavailable', 'NND Activity tombstones are unavailable', { cause: error });
  }
  let journal;
  try { journal = JSON.parse(source); } catch { throw invalid(); }
  if (!journal || journal.version !== 1 || journal.subjectId !== owner.subjectId
    || JSON.stringify(journal.workspaceIds) !== JSON.stringify(owner.workspaceIds)
    || !Number.isSafeInteger(journal.nextSequence) || journal.nextSequence < 1
    || !Number.isSafeInteger(journal.floor) || journal.floor < 0 || journal.floor >= journal.nextSequence
    || !Array.isArray(journal.entries) || journal.entries.length > TOMBSTONE_LIMIT
    || journal.entries.some((entry) => !validEntry(entry))) throw invalid();
  let previous = journal.floor;
  for (const entry of journal.entries) {
    // Invariant: a missing retained deletion must be an explicit gap, never
    // silently skipped by an otherwise syntactically valid journal.
    if (entry.sequence !== previous + 1 || entry.sequence >= journal.nextSequence) throw invalid();
    previous = entry.sequence;
  }
  if (previous !== journal.nextSequence - 1) throw invalid();
  return journal;
}

function currentPair(contexts, entry, owner) {
  const context = contexts.get(entry.sessionId);
  return context?.createdAt === entry.createdAt && context.subjectId === owner.subjectId
    && JSON.stringify([...context.workspaceIds].sort()) === JSON.stringify(owner.workspaceIds);
}

/** Write an intent before deleting the authoritative session catalog entry. */
export class NndActivityTombstones {
  constructor(catalogPath, writer = persistAtomicJson) {
    this.catalogPath = catalogPath; this.writer = writer; this.pending = Promise.resolve();
  }
  async #mutate(principal, change) {
    const task = this.pending.catch(() => undefined).then(async () => {
      const owner = ownerKey(principal); const path = journalPath(this.catalogPath, principal);
      const journal = await readJournal(path, owner);
      const result = change(journal);
      if (result.changed) await this.writer(path, journal);
      return result.value;
    });
    this.pending = task;
    return task;
  }
  async prepare(context, contexts) {
    if (!this.catalogPath) return null;
    return this.#mutate(contextPrincipal(context), (journal) => {
      let reconciled = false;
      if (contexts) for (const entry of journal.entries) {
        if (entry.state === 'intent' && !currentPair(contexts, entry, journal)) { entry.state = 'deleted'; reconciled = true; }
      }
      const existing = journal.entries.find((entry) => entry.sessionId === context.sessionId
        && entry.createdAt === context.createdAt && entry.state === 'intent');
      if (existing) return { changed: reconciled, value: existing.sequence };
      if (journal.entries.length >= TOMBSTONE_LIMIT) {
        const oldest = journal.entries[0];
        if (oldest.state !== 'deleted') throw new ContractError('nnd_activity_tombstones_capacity', 'NND Activity tombstone retention is full');
        journal.entries.shift(); journal.floor = oldest.sequence;
      }
      const sequence = journal.nextSequence++;
      journal.entries.push({ sequence, sessionId: context.sessionId, createdAt: context.createdAt,
        deletedAt: Date.now(), state: 'intent' });
      return { changed: true, value: sequence };
    });
  }
  async committed(context, sequence) {
    if (!this.catalogPath) return;
    await this.#mutate(contextPrincipal(context), (journal) => {
      const entry = journal.entries.find((item) => item.sequence === sequence
        && item.sessionId === context.sessionId && item.createdAt === context.createdAt);
      if (!entry) throw invalid();
      if (entry.state === 'deleted') return { changed: false };
      entry.state = 'deleted';
      return { changed: true };
    });
  }
  async beforeCreate(sessionId, principal, contexts) {
    if (!this.catalogPath) return;
    await this.#mutate(principal, (journal) => {
      let changed = false;
      for (const entry of journal.entries) {
        if (entry.sessionId !== sessionId || entry.state !== 'intent') continue;
        if (currentPair(contexts, entry, journal)) throw new ContractError('nnd_session_exists', 'NND session context already exists');
        entry.state = 'deleted'; changed = true;
      }
      return { changed };
    });
  }
  async page(principal, contexts, options = {}) {
    if (!this.catalogPath) throw new ContractError('nnd_activity_tombstones_unavailable', 'Durable NND Activity tombstones are unavailable');
    const { after = 0, limit = 50 } = options;
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some((key) => !['after', 'limit'].includes(key))
      || !Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new ContractError('nnd_activity_tombstones_request_invalid', 'NND Activity tombstone page request is invalid');
    }
    await this.pending.catch(() => undefined);
    const owner = ownerKey(principal); const journal = await readJournal(journalPath(this.catalogPath, principal), owner);
    const committed = journal.entries.filter((entry) => entry.state === 'deleted' || !currentPair(contexts, entry, journal));
    if (after < journal.floor || after >= journal.nextSequence) return { status: 'gap', floor: journal.floor, nextCursor: null,
      records: [], historyComplete: false };
    const records = committed.filter((entry) => entry.sequence > after).slice(0, limit)
      .map(({ sequence, sessionId, createdAt, deletedAt }) => ({ sequence, sessionID: sessionId, createdAt, deletedAt, kind: 'deleted' }));
    return { status: 'page', floor: journal.floor, nextCursor: records.at(-1)?.sequence ?? after,
      records, historyComplete: false };
  }
}
