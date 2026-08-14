// SPDX-License-Identifier: Apache-2.0
import { realpath, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { ContractError, newId } from '../ids.js';
import {
  loadEffectiveStartupConfiguration, runtimeHookRoots, runtimeSkillRoots,
} from '../startup-configuration.js';

export async function createWorkspaceConversation(workspace, value) {
  if (!value.trim()) throw new ContractError('workspace_path_required', 'use /workspace PATH');
  const root = await canonicalDirectory(value);
  const paths = workspace.options.dataPaths;
  if (!paths) throw new ContractError('workspace_change_unavailable', 'runtime data paths are unavailable');
  const effective = await loadEffectiveStartupConfiguration({ paths, workspaceRoot: root });
  return workspace.create(basename(root) || 'Workspace', newId('session'), {
    role: 'standard', config: effective.config,
    hookRoots: runtimeHookRoots(paths, effective.project),
    skillRoots: runtimeSkillRoots(paths, effective.project),
  });
}

export function createNextConversation(workspace) {
  let ordinal = workspace.sessions.size + 1;
  const names = new Set([...workspace.sessions.values()].map((session) => session.name));
  while (names.has(`Conversation ${ordinal}`)) ordinal += 1;
  return workspace.create(`Conversation ${ordinal}`, newId('session'), { role: 'standard' });
}

async function canonicalDirectory(value) {
  let root;
  try { root = await realpath(resolve(value)); } catch {
    throw new ContractError('workspace_path_invalid', 'workspace path does not exist');
  }
  if (!(await stat(root)).isDirectory()) {
    throw new ContractError('workspace_path_invalid', 'workspace path is not a directory');
  }
  return root;
}
