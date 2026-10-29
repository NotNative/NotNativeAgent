// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';

/** Wrap every installed executor with the same native identity boundary. */
export function workspaceIdentityGuard(check) {
  if (check !== null && check !== undefined && typeof check !== 'function') {
    throw new ContractError('desktop_workspace_binding_invalid', 'desktop tool workspace identity check is invalid');
  }
  const assert = async () => {
    if (!check) return;
    try { await check(); }
    catch (error) {
      throw new ContractError('tool_revalidation_drift', 'desktop workspace identity changed before tool execution', { cause: error });
    }
  };
  return Object.freeze({
    assert,
    wrap(executor) {
      return check ? async function guardedExecutor(...args) {
        await assert();
        args[1]?.throwIfAborted();
        return executor.apply(this, args);
      } : executor;
    },
  });
}
