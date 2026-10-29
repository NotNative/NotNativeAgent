// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { acquireDesktopServiceLock, withDesktopServiceLease } from './desktop-service-lock.js';
import { drainDesktopLegacyTakeover } from './desktop-legacy-takeover.js';
import { assertNoDesktopInstallMarker } from './desktop-install-marker.js';
import { assertNoDesktopInstallTransaction } from './desktop-install-storage.js';
import { readMigrationParents, prepareDesktopMigration } from './desktop-migration-validation.js';
import { acquireMigrationSessionLocks } from './desktop-migration-locks.js';
import { assertNoDesktopMigration, stageDesktopMigration, loadDesktopMigration, applyDesktopMigration, recoverDesktopMigration } from './desktop-migration-storage.js';
import { boundedMigrationRead, digest, migrationError } from './desktop-migration-files.js';

export async function runDesktopMigration(identity, paths, action, options = {}) {
  if (!['migrate', 'migration-recover'].includes(action)) throw migrationError();
  const lease = await acquireDesktopServiceLock({ dataRoot: identity.data_root });
  try {
    return await withDesktopServiceLease(lease, identity.data_id, async (signal) => {
      await assertNoDesktopInstallTransaction(identity);
      await assertNoDesktopInstallMarker(identity);
      const census = await drainDesktopLegacyTakeover(identity, signal);
      if (action === 'migration-recover') return recover(identity, paths, signal);
      await assertNoDesktopMigration(identity);
      const parents = await readMigrationParents(paths);
      const release = await acquireMigrationSessionLocks(paths, parents.records.map((record) => record.sessionId), signal);
      try {
        const current = await boundedMigrationRead(paths.root, join(paths.sessions, 'desktop-contexts.json'), 1048576);
        if (digest(current) !== digest(parents.bytes)) throw migrationError();
        const plan = await prepareDesktopMigration(paths, parents, signal);
        signal.throwIfAborted();
        const transaction = await stageDesktopMigration(identity, plan, census);
        await options.checkpoint?.('prepared');
        await applyDesktopMigration(identity, transaction, signal, options.checkpoint);
        return { migrated: true, transaction_id: transaction.record.id, sessions: plan.sessions.length, files: plan.files.length };
      } finally { await release(); }
    }, { timeoutMs: 300000 });
  } finally { await lease.close(); }
}
async function recover(identity, paths, signal) {
  const transaction = await loadDesktopMigration(identity);
  const release = await acquireMigrationSessionLocks(paths, transaction.record.sessions, signal);
  try {
    const state = await recoverDesktopMigration(identity, transaction, signal);
    return { recovered: true, transaction_id: transaction.record.id, state };
  } finally { await release(); }
}
