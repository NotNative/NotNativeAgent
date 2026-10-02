// SPDX-License-Identifier: Apache-2.0
import { open, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { ContractError } from './ids.js';
import { withNndServiceLease } from './nnd-service-lock.js';
import { ensurePrivateNndRuntimeDirectory } from './nnd-service-private-storage.js';
import { scanNndLegacyOwners } from './nnd-legacy-census.js';
import { exactRecord } from './nnd-service-contract.js';
import { assertNoNndMigration } from './nnd-migration-storage.js';

function invalid(cause) {
  return new ContractError('nnd_owner_unverified', 'NND admission evidence is invalid or legacy migration is required. Existing files were preserved.', { cause });
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
function validateReceipt(record, identity, legacy) {
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
    try { await lstat(join(paths.sessions, `nnd-contexts.json${suffix}`)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw invalid(error); }
    throw invalid();
  }
}
// Security: every startup checks legacy processes; a historical receipt cannot exclude an old executable.
export async function admitFreshNndServiceData(paths, identity, lease) {
  return withNndServiceLease(lease, identity.data_id, async (signal) => {
    await assertNoNndMigration(identity);
    const census = await scanNndLegacyOwners(identity, signal);
    const directory = await ensurePrivateNndRuntimeDirectory(identity.data_root, { signal });
    const path = join(directory.path, 'admission.json');
    const existing = await readReceipt(path);
    if (existing) { validateReceipt(existing, identity, false); return existing; }
    const prior = await readReceipt(join(paths.config, 'nnd-supervised-owner.json'));
    if (prior) validateReceipt(prior, identity, true);
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
