// SPDX-License-Identifier: Apache-2.0
import { open, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { ContractError } from './ids.js';
import { withDesktopServiceLease } from './desktop-service-lock.js';
import { ensurePrivateDesktopRuntimeDirectory } from './desktop-service-private-storage.js';
import { drainDesktopLegacyTakeover } from './desktop-legacy-takeover.js';
import { exactRecord } from './desktop-service-contract.js';
import { assertNoDesktopMigration } from './desktop-migration-storage.js';
import { assertNoDesktopInstallTransaction } from './desktop-install-storage.js';

function invalid(cause) {
  return new ContractError('desktop_owner_unverified', 'desktop admission evidence is invalid or legacy migration is required. Existing files were preserved.', { cause });
}
async function readReceipt(path) {
  let file;
  try { file = await open(path, 'r'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw invalid(error); }
  try {
    const info = await file.stat(); if (!info.isFile() || info.size > 2048) throw invalid();
    const buffer = Buffer.alloc(2049); let count = 0;
    while (count < buffer.length) {
      const item = await file.read(buffer, count, buffer.length - count, null);
      if (!item.bytesRead) break; count += item.bytesRead;
    }
    if (count > 2048) throw invalid();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count)));
  } catch (cause) { throw invalid(cause); }
  finally { await file.close(); }
}
export function validateDesktopAdmissionReceipt(record, identity, legacy = false) {
  const keys = legacy ? ['version', 'data_id', 'installation_id'] : ['version', 'data_id', 'installation_id', 'basis', 'census'];
  if (!exactRecord(record, keys) || record.version !== (legacy ? '1.0' : '2.0')
    || record.data_id !== identity.data_id || record.installation_id !== identity.installation_id) throw invalid();
  if (!legacy && (!['no_nnd_catalog', 'prior_supervised_admission', 'legacy_catalog_migration'].includes(record.basis)
    || !exactRecord(record.census, ['version', 'scanned', 'legacy', 'unknown', 'checked_at'])
    || record.census.version !== '1.0' || record.census.legacy !== 0 || record.census.unknown !== 0
    || !Number.isSafeInteger(record.census.scanned) || record.census.scanned < 1 || record.census.scanned > 4096
    || !Number.isFinite(Date.parse(record.census.checked_at)))) throw invalid();
}
async function assertNoLegacyCatalog(paths) {
  for (const suffix of ['', '.children', '.activity']) {
    try { await lstat(join(paths.sessions, `desktop-contexts.json${suffix}`)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw invalid(error); }
    throw invalid();
  }
}
// Security: every startup checks legacy processes; a historical receipt cannot exclude an old executable.
export async function admitFreshDesktopServiceData(paths, identity, lease) {
  return withDesktopServiceLease(lease, identity.data_id, async (signal) => {
    await assertNoDesktopInstallTransaction(identity);
    await assertNoDesktopMigration(identity);
    const census = await drainDesktopLegacyTakeover(identity, signal);
    const directory = await ensurePrivateDesktopRuntimeDirectory(identity.data_root, { signal });
    const path = join(directory.path, 'admission.json');
    const existing = await readReceipt(path);
    if (existing) { validateDesktopAdmissionReceipt(existing, identity, false); return existing; }
    const prior = await readReceipt(join(paths.config, 'desktop-supervised-owner.json'));
    if (prior) validateDesktopAdmissionReceipt(prior, identity, true);
    else await assertNoLegacyCatalog(paths);
    signal.throwIfAborted();
    const receipt = { version: '2.0', data_id: identity.data_id, installation_id: identity.installation_id,
      basis: prior ? 'prior_supervised_admission' : 'no_nnd_catalog', census };
    const writer = await open(path, 'wx', 0o600);
    try { await writer.writeFile(JSON.stringify(receipt)); await writer.sync(); }
    finally { await writer.close(); }
    return Object.freeze(receipt);
  });
}
