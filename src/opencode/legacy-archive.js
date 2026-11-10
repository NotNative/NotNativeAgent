// SPDX-License-Identifier: Apache-2.0
// The legacy conversation archive: read-only access to the standalone client's
// SQLite store. Why a separate module from the live session index: imported
// conversations belong to the standalone product, never to NNA, so they live
// in their own index, are listed as archived, and every mutating route refuses
// by contract rather than by absence of support.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

/** The archived index record for one imported conversation. */
export function archiveEntry(row) {
  return Object.freeze({
    ocId: row.id, title: row.title, directory: row.directory ?? '',
    parentOcId: row.parent_id ?? null, archived: true,
    createdAt: row.time_created ?? null, updatedAt: row.time_updated ?? null,
    tokens: { input: row.tokens_input ?? 0, output: row.tokens_output ?? 0, reasoning: row.tokens_reasoning ?? 0 },
  });
}

export class LegacyArchive {
  #db = null;
  #path;
  constructor(path) {
    this.#path = path;
  }

  /** Why lazy: the 4.5 GB source must be opened only when an archive route
   *  actually needs it, and always read-only, so a running standalone client
   *  is never disturbed and NNA never takes ownership of the store. */
  open() {
    if (this.#db) return this.#db;
    if (!existsSync(this.#path)) {
      throw Object.assign(new Error('legacy store not found'), { code: 'legacy_store_missing' });
    }
    this.#db = new DatabaseSync(this.#path, { readOnly: true });
    return this.#db;
  }

  close() {
    this.#db?.close?.();
    this.#db = null;
  }

  list() {
    const db = this.open();
    return db.prepare('SELECT * FROM session_v2 ORDER BY time_updated DESC').all().map(archiveEntry);
  }

  get(ocId) {
    const db = this.open();
    const row = db.prepare('SELECT * FROM session_v2 WHERE id = ?').get(ocId);
    return row ? archiveEntry(row) : null;
  }

  /** The archived messages of one conversation, oldest first, shaped like the
   *  live wire history so a viewer needs no second rendering path. */
  messages(ocId) {
    const db = this.open();
    if (!this.get(ocId)) {
      throw Object.assign(new Error('archived conversation not found'), { code: 'archive_session_missing' });
    }
    const rows = db.prepare(
      'SELECT id, type, seq, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq',
    ).all(ocId);
    return rows.map((row) => {
      let text = '';
      try { text = String(JSON.parse(row.data)?.text ?? ''); } catch { text = ''; }
      return { id: row.id, type: row.type, seq: row.seq, createdAt: row.time_created, text };
    });
  }
}

/** The enforced refusals: every mutating archive route answers the same typed
 *  conflict, so archived history can never silently become live model context
 *  under NNA's governance. */
export function archiveMutationRefusal(action) {
  return Object.assign(new Error(
    `${action} on an archived conversation is not available; archived history is read-only. `
    + 'Adopt the conversation explicitly to continue it under NNA governance.',
  ), { code: 'archive_read_only' });
}

/** Adoption converts one archived conversation into a real journal-backed
 *  session. Why a separate function taking a factory: the archive stays
 *  read-only; the caller decides what "adopt" constructs, so the archive
 *  module never grows a write path. */
export async function adoptArchivedSession(archive, ocId, construct) {
  const entry = archive.get(ocId);
  if (!entry) throw Object.assign(new Error('archived conversation not found'), { code: 'archive_session_missing' });
  const messages = archive.messages(ocId);
  return construct({ entry, messages });
}
