// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

const keyOf = value => process.platform === 'win32' ? value.toLowerCase() : value;

/** The native session host owns this guard while a workspace admission is
 * revoked. A concurrent create observes it before catalog publication. */
export class NndWorkspaceRevocationGuard {
  #pending = new Set();
  has(binding) { return Boolean(binding && this.#pending.has(keyOf(binding.root))); }
  async with(root, records, creating, action) {
    const key = keyOf(root);
    if (this.#pending.has(key)) throw new ContractError('nnd_workspace_in_use', 'Workspace revocation is already in progress.');
    this.#pending.add(key);
    try {
      const bound = records.some(value => {
        const stored = value.workspaceBinding?.root ?? value.directory;
        return typeof stored === 'string' && keyOf(stored) === key;
      });
      if (bound || creating > 0) throw new ContractError('nnd_workspace_in_use', 'Workspace still has sessions or a session is being created.');
      return await action();
    } finally { this.#pending.delete(key); }
  }
}
