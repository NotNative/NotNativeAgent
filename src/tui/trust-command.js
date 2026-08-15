// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { trustWorkspace, untrustWorkspace } from '../experience/trust.js';

export async function handleWorkspaceTrust(trusted, workspace) {
  const path = workspace?.options?.trustedWorkspacesPath;
  if (!path) throw new ContractError('workspace_trust_unavailable', 'workspace trust store is unavailable');
  const root = workspace.activeConfig?.()?.workspaceRoot;
  if (typeof root !== 'string' || root.length === 0) {
    throw new ContractError('workspace_trust_unavailable', 'active workspace root is unavailable');
  }
  const result = trusted ? await trustWorkspace(path, root) : await untrustWorkspace(path, root);
  workspace.projection.showNotice('configuration', `${root} is ${trusted ? 'trusted' : 'untrusted'}; restart NNA to recompute project configuration and hooks.`);
  workspace.onChange();
  return result;
}
