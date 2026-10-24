// SPDX-License-Identifier: Apache-2.0
import { validIdentity } from './reliability/process-identity.js';

export function migrateDreamRunOwner(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!db.prepare('PRAGMA table_info(dream_runs)').all().some((column) => column.name === 'owner_identity')) {
      db.exec('ALTER TABLE dream_runs ADD COLUMN owner_identity TEXT');
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export async function recoverInterruptedDreamRuns(db, processIdentity, assertNotClosing) {
  const rows = db.prepare("SELECT id, state, owner_identity FROM dream_runs WHERE state IN ('queued','running')").all();
  for (const row of rows) {
    let identity;
    try { identity = JSON.parse(row.owner_identity); } catch { continue; }
    // Invariant: an unowned legacy row cannot be attributed to a dead process safely.
    if (!validIdentity(identity) || !identity.start_id) continue;
    const comparison = await processIdentity.compare(identity);
    assertNotClosing();
    if (!['dead', 'different'].includes(comparison)) continue;
    db.prepare(`UPDATE dream_runs SET state='cancelled', result_code='restart_recovered', finished_at=?
      WHERE id=? AND state=? AND owner_identity=?`)
      .run(new Date().toISOString(), row.id, row.state, row.owner_identity);
  }
}

export function unverifiedActiveDreamRunCount(db) {
  let count = 0;
  const rows = db.prepare("SELECT owner_identity FROM dream_runs WHERE state IN ('queued','running')").iterate();
  for (const row of rows) {
    let identity;
    try { identity = JSON.parse(row.owner_identity); } catch { identity = null; }
    if (!validIdentity(identity) || !identity.start_id) count += 1;
  }
  return count;
}
