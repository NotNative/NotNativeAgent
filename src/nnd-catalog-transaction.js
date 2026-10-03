// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { catalogRecord } from './nnd-session-helpers.js';

/** Serialize catalog writes so failed candidates never enter a later snapshot. */
export function enqueueNndCatalogChange(previous, contexts, change, commit, path, writer, limitBytes) {
  return previous.catch(() => undefined).then(async () => {
    const candidate = new Map(contexts);
    change(candidate);
    const records = [...candidate.values()].map(catalogRecord);
    if (Buffer.byteLength(`${JSON.stringify(records, null, 2)}\n`, 'utf8') > limitBytes) {
      throw new ContractError('nnd_catalog_capacity', 'NND session catalog capacity is full');
    }
    await writer(path, records);
    commit();
  });
}
