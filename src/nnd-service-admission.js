// SPDX-License-Identifier: Apache-2.0
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ContractError } from './ids.js';

// Security: pre-supervisor hosts did not take this lease. Existing data needs an explicit future migration.
export async function admitFreshNndServiceData(paths, identity) {
  const marker = join(paths.config, 'nnd-supervised-owner.json');
  let file;
  try { file = await open(marker, 'r'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (file) {
    try {
      const buffer = Buffer.alloc(1025); const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const record = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
      if (bytesRead > 1024 || record.version !== '1.0' || record.data_id !== identity.data_id
        || record.installation_id !== identity.installation_id) throw new Error('owner mismatch');
      return;
    } catch (cause) { throw new ContractError('nnd_owner_unverified', 'NND service admission record is invalid', { cause }); }
    finally { await file.close(); }
  }
  const config = await readdir(paths.config);
  const sessions = await readdir(paths.sessions);
  const tabs = await readdir(paths.rootTui);
  if (config.includes('manifest.json') || sessions.length || tabs.length) {
    throw new ContractError('nnd_owner_unverified', 'Existing NNA data requires verified legacy-owner migration before supervised NND activation. Files were preserved.');
  }
  const writer = await open(marker, 'wx', 0o600);
  try { await writer.writeFile(JSON.stringify({ version: '1.0', data_id: identity.data_id, installation_id: identity.installation_id })); }
  finally { await writer.close(); }
}
