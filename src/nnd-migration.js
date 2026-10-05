// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { acquireNndServiceLock, withNndServiceLease } from './nnd-service-lock.js';
import { drainNndLegacyTakeover } from './nnd-legacy-takeover.js';
import { assertNoNndInstallMarker } from './nnd-install-marker.js';
import { assertNoNndInstallTransaction } from './nnd-install-storage.js';
import { readMigrationParents, prepareNndMigration } from './nnd-migration-validation.js';
import { acquireMigrationSessionLocks } from './nnd-migration-locks.js';
import { assertNoNndMigration, stageNndMigration, loadNndMigration, applyNndMigration, recoverNndMigration } from './nnd-migration-storage.js';
import { boundedMigrationRead, digest, migrationError } from './nnd-migration-files.js';

export async function runNndMigration(identity, paths, action, options = {}) {
  if (!['migrate', 'migration-recover'].includes(action)) throw migrationError();
  const lease = await acquireNndServiceLock({ dataRoot: identity.data_root });
  try {
    return await withNndServiceLease(lease, identity.data_id, async (signal) => {
      await assertNoNndInstallTransaction(identity);
      await assertNoNndInstallMarker(identity);
      const census = await drainNndLegacyTakeover(identity, signal);
      if (action === 'migration-recover') return recover(identity, paths, signal);
      await assertNoNndMigration(identity);
      const parents = await readMigrationParents(paths);
      const release = await acquireMigrationSessionLocks(paths, parents.records.map((record) => record.sessionId), signal);
      try {
        const current = await boundedMigrationRead(paths.root, join(paths.sessions, 'nnd-contexts.json'), 1048576);
        if (digest(current) !== digest(parents.bytes)) throw migrationError();
        const plan = await prepareNndMigration(paths, parents, signal);
        signal.throwIfAborted();
        const transaction = await stageNndMigration(identity, plan, census);
        await options.checkpoint?.('prepared');
        await applyNndMigration(identity, transaction, signal, options.checkpoint);
        return { migrated: true, transaction_id: transaction.record.id, sessions: plan.sessions.length, files: plan.files.length };
      } finally { await release(); }
    }, { timeoutMs: 300000 });
  } finally { await lease.close(); }
}
async function recover(identity, paths, signal) {
  const transaction = await loadNndMigration(identity);
  const release = await acquireMigrationSessionLocks(paths, transaction.record.sessions, signal);
  try {
    const state = await recoverNndMigration(identity, transaction, signal);
    return { recovered: true, transaction_id: transaction.record.id, state };
  } finally { await release(); }
}
