// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { preflightDesktopWorkspaceCatalog } from './desktop-workspace-binding.js';

/** Preserve sessions whose admitted root has vanished or been revoked while
 * restoring healthy roots. Poisoned primary or legacy records remain fatal. */
export async function partitionDesktopCatalog(records, resolver, validRecord) {
  const restorable = [], quarantined = [];
  for (const record of records) {
    if (!validRecord(record)) throw new ContractError('desktop_catalog_invalid', 'desktop session catalog is invalid');
    try { await preflightDesktopWorkspaceCatalog([record], resolver, validRecord); }
    catch (error) {
      if (error?.code !== 'desktop_workspace_binding_invalid' || !resolver) throw error;
      const primary = await resolver();
      if (!record.workspaceBinding || record.workspaceBinding.id === primary.id) throw error;
      quarantined.push(record);
      continue;
    }
    restorable.push(record);
  }
  return { restorable, quarantined };
}
