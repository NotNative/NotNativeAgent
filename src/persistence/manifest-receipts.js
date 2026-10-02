// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { unlink, lstat } from 'node:fs/promises';
import { assertManifestLease, openManifestDatabase } from './manifest-lock.js';
import { manifestFailure, readTargetSnapshot } from './manifest-files.js';

export async function openManifestReceipts(lease) {
  const target = assertManifestLease(lease);
  const database = await openManifestDatabase(join(target.storage, 'receipts.sqlite'));
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS operations (
      id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, before_hash TEXT NOT NULL, after_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('prepared','saved','unpublished')), backup TEXT, staged TEXT, created_at INTEGER NOT NULL
    ) STRICT;`);
    return database;
  } catch { database.close(); throw manifestFailure('manifest_receipt_invalid'); }
}
export async function reconcileManifestReceipts(lease, database) {
  const target = assertManifestLease(lease);
  const pending = database.prepare("SELECT * FROM operations WHERE state='prepared' LIMIT 2").all();
  if (pending.length > 1) throw manifestFailure('manifest_receipt_ambiguous', 'unknown');
  if (!pending.length) return;
  const row = pending[0];
  await recoverPreparedLink(target, row);
  const current = await readTargetSnapshot(target);
  let state;
  if (current.revision === row.after_hash) state = 'saved';
  else if (current.revision === row.before_hash) state = 'unpublished';
  else throw manifestFailure('manifest_receipt_ambiguous', 'unknown');
  database.prepare('UPDATE operations SET state=? WHERE id=?').run(state, row.id);
}
export function manifestReceipt(database, operationId, payloadHash) {
  const row = database.prepare('SELECT * FROM operations WHERE id=?').get(operationId);
  if (row && row.payload_hash !== payloadHash) throw manifestFailure('manifest_operation_conflict');
  return row;
}
export function prepareManifestReceipt(database, input) {
  if (database.prepare('SELECT COUNT(*) AS count FROM operations').get().count >= 128) {
    throw manifestFailure('manifest_receipt_capacity');
  }
  database.prepare('INSERT INTO operations VALUES (?,?,?,?,?,?,?,?)').run(input.id, input.payloadHash,
    input.before, input.after, 'prepared', input.backup, input.staged ?? null, Date.now());
}
export async function reserveManifestReceipt(lease, database) {
  const target = assertManifestLease(lease);
  const count = database.prepare('SELECT COUNT(*) AS count FROM operations').get().count;
  if (count < 128) return;
  if (count > 128) throw manifestFailure('manifest_receipt_invalid');
  const oldest = database.prepare("SELECT id,backup FROM operations WHERE state IN ('saved','unpublished') ORDER BY created_at,rowid LIMIT 1").get();
  if (!oldest) throw manifestFailure('manifest_receipt_capacity');
  if (oldest.backup !== null) {
    if (!/^backup-[a-f0-9-]{36}\.bin$/u.test(oldest.backup)) throw manifestFailure('manifest_receipt_invalid');
    await unlink(join(target.storage, oldest.backup)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  database.prepare('DELETE FROM operations WHERE id=?').run(oldest.id);
}
export function finishManifestReceipt(database, id, state) {
  database.prepare('UPDATE operations SET state=? WHERE id=? AND state=?').run(state, id, 'prepared');
}
export function receiptOutcome(row, replayed = false) {
  return Object.freeze({ operationId: row.id, persistence: row.state, beforeRevision: row.before_hash,
    persistedRevision: row.state === 'saved' ? row.after_hash : null, application: 'not_applied', replayed,
    replayWindow: 'last_128_operations' });
}

async function recoverPreparedLink(target, row) {
  const current = await lstat(target.path).catch(error => { if(error.code==='ENOENT') return null; throw error; });
  if (!current || current.nlink === 1) return;
  if (row.before_hash !== 'absent' || current.nlink !== 2 || typeof row.staged !== 'string'
    || !/^stage-[a-f0-9-]{36}\.json$/u.test(row.staged)) throw manifestFailure('manifest_receipt_ambiguous','unknown');
  const staged=join(target.storage,row.staged), info=await lstat(staged);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink!==2 || info.ino!==current.ino || info.dev!==current.dev
    || info.size>1048576 || (await readTargetSnapshot({path:staged},true)).revision!==row.after_hash) throw manifestFailure('manifest_receipt_ambiguous','unknown');
  await unlink(staged);
}
