// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { restoreTranscript } from './workspace-transcript.js';

export async function compactActiveConversation(workspace) {
  return compactWorkspaceConversation(workspace, workspace.projection.activeId, { notice: true });
}

export async function compactWorkspaceConversation(workspace, sessionId, options = {}) {
  const projected = requireProjectedSession(workspace, sessionId);
  const session = requireEngineSession(workspace, sessionId);
  const result = await session.engine.compactConversation();
  projected.records = [];
  projected.expandedTurns.clear();
  projected.detailedTurns.clear();
  restoreTranscript(workspace.projection, session.id, session.engine.transcript);
  if (Number.isFinite(result.afterBytes)) {
    projected.contextBytes = result.afterBytes;
    projected.contextTokens = Math.ceil(result.afterBytes / 3);
  }
  const reduced = result.reduced ? ` and reduced ${result.reduced} retained payloads` : '';
  if (options.notice) workspace.projection.showNotice(
    'context', `Compaction omitted ${result.omitted} settled records${reduced}; retained ${result.retained}.`,
  );
  workspace.tabPersistence?.observe(workspace._savePoolForBroker(), workspace._tasksForBroker());
  workspace.onChange();
  return result;
}

export function requestConversationClear(workspace) {
  const session = workspace.projection.active();
  session.confirmClear = true;
  workspace.projection.showNotice('context', 'This removes the active conversation context. Confirm with /confirm clear conversation.');
  workspace.onChange();
}

export async function confirmConversationClear(workspace) {
  const projected = workspace.projection.active();
  if (!projected.confirmClear) throw new ContractError('clear_confirmation_missing', 'request /clear conversation before confirming');
  const result = await clearWorkspaceConversation(workspace, projected.id, { notice: true });
  projected.confirmClear = false;
  return result;
}

export async function clearWorkspaceConversation(workspace, sessionId, options = {}) {
  const projected = requireProjectedSession(workspace, sessionId);
  const session = requireEngineSession(workspace, sessionId);
  const result = await session.engine.clearConversation();
  projected.records = [];
  projected.expandedTurns.clear();
  projected.detailedTurns.clear();
  projected.contextBytes = 0;
  projected.contextTokens = 0;
  projected.confirmClear = false;
  if (options.notice) workspace.projection.showNotice('context', `Cleared ${result.removed} context records from this conversation.`);
  workspace.tabPersistence?.observe(workspace._savePoolForBroker(), workspace._tasksForBroker());
  workspace.onChange();
  return result;
}

function requireProjectedSession(workspace, sessionId) {
  const projected = workspace.projection.sessions.get(sessionId);
  if (!projected) throw new ContractError('session_missing', 'conversation is no longer available');
  return projected;
}

function requireEngineSession(workspace, sessionId) {
  const session = workspace.sessions.get(sessionId);
  if (!session) throw new ContractError('session_missing', 'conversation is no longer available');
  return session;
}
