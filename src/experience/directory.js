// SPDX-License-Identifier: Apache-2.0
import { realpath, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { ContractError, newId } from '../ids.js';
import {
  loadEffectiveStartupConfiguration, runtimeHookRoots, runtimeSkillRoots,
} from '../startup-configuration.js';

const PENDING_CONVERSATION_NAMES = new WeakMap();

export async function createWorkspaceConversation(workspace, value) {
  requireWorkspace(workspace);
  if (typeof value !== 'string' || !value.trim()) throw new ContractError('workspace_path_required', 'use /workspace PATH');
  const root = await canonicalDirectory(value);
  const paths = workspace.options.dataPaths;
  if (!paths) throw new ContractError('workspace_change_unavailable', 'runtime data paths are unavailable');
  const effective = await loadEffectiveStartupConfiguration({ paths, workspaceRoot: root });
  return workspace.create(basename(root) || 'Workspace', newId('session'), {
    role: 'standard', config: effective.config,
    nameLocked: false,
    hookRoots: runtimeHookRoots(paths, effective.project),
    skillRoots: runtimeSkillRoots(paths, effective.project),
  });
}

export function createNextConversation(workspace) {
  requireWorkspace(workspace);
  let ordinal = workspace.sessions.size + 1;
  const names = new Set([...workspace.sessions.values()].map((session) => session.name));
  const pending = PENDING_CONVERSATION_NAMES.get(workspace) ?? new Set();
  for (const name of pending) names.add(name);
  while (names.has(`Conversation ${ordinal}`)) ordinal += 1;
  const name = `Conversation ${ordinal}`;
  pending.add(name); PENDING_CONVERSATION_NAMES.set(workspace, pending);
  return Promise.resolve(workspace.create(name, newId('session'), { role: 'standard', nameLocked: false }))
    .finally(() => {
      pending.delete(name);
      if (pending.size === 0) PENDING_CONVERSATION_NAMES.delete(workspace);
    });
}

export function observeWorkspaceChange(workspace, sessionId, event) {
  const projected = workspace.projection.sessions.get(sessionId);
  if (!projected) return;
  projected.metadata = Object.freeze({ ...projected.metadata, workspace: event.workspaceRoot });
  workspace.onChange();
  workspace.tabPersistence.observe(workspace._savePoolForBroker(), workspace._tasksForBroker());
}

async function canonicalDirectory(value) {
  let root;
  try { root = await realpath(resolve(value)); } catch (error) {
    const message = error?.code === 'ENOENT' ? 'workspace path does not exist' : 'workspace path could not be resolved';
    throw new ContractError('workspace_path_invalid', message);
  }
  let details;
  try { details = await stat(root); } catch {
    throw new ContractError('workspace_path_invalid', 'workspace path could not be inspected');
  }
  if (!details.isDirectory()) {
    throw new ContractError('workspace_path_invalid', 'workspace path is not a directory');
  }
  return root;
}

function requireWorkspace(workspace) {
  if (!workspace || !(workspace.sessions instanceof Map) || typeof workspace.create !== 'function') {
    throw new ContractError('workspace_change_unavailable', 'workspace conversation management is unavailable');
  }
}
