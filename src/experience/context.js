// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { restoreTranscript } from './transcript.js';

const CONTEXT_NOTICE = 'context';
// Context budgeting uses the same conservative UTF-8 estimate as the engine: about three bytes per token.
const ESTIMATED_BYTES_PER_TOKEN = 3;

export async function compactActiveConversation(workspace) {
  return compactWorkspaceConversation(workspace, workspace.projection.activeId, { notice: true });
}

export async function handoffActiveConversation(workspace) {
  return handoffWorkspaceConversation(workspace, workspace.projection.activeId, { notice: true });
}

export async function handoffWorkspaceConversation(workspace, sessionId, options = {}) {
  const projected = requireProjectedSession(workspace, sessionId);
  const session = requireEngineSession(workspace, sessionId);
  const result = await session.engine.handoffConversation();
  refreshProjectedContext(workspace, projected, session, result);
  if (options.notice) workspace.projection.showNotice(
    CONTEXT_NOTICE, `Terse self-handoff created from ${result.omitted} records; future context starts from the handoff.`,
  );
  persistWorkspaceContext(workspace);
  return result;
}

export async function compactWorkspaceConversation(workspace, sessionId, options = {}) {
  const projected = requireProjectedSession(workspace, sessionId);
  const session = requireEngineSession(workspace, sessionId);
  const result = await session.engine.compactConversation();
  refreshProjectedContext(workspace, projected, session, result);
  const reduced = result.reduced ? ` and reduced ${result.reduced} retained payloads` : '';
  if (options.notice) workspace.projection.showNotice(
    CONTEXT_NOTICE, `Compaction omitted ${result.omitted} settled records${reduced}; retained ${result.retained}.`,
  );
  persistWorkspaceContext(workspace);
  return result;
}

function refreshProjectedContext(workspace, projected, session, result) {
  resetProjectedTranscript(workspace, projected, session);
  if (Number.isFinite(result.afterBytes)) {
    projected.contextBytes = result.afterBytes;
    projected.contextTokens = Math.ceil(result.afterBytes / ESTIMATED_BYTES_PER_TOKEN);
  }
}

function resetProjectedTranscript(workspace, projected, session) {
  projected.records = [];
  projected.expandedTurns.clear();
  projected.detailedTurns.clear();
  restoreTranscript(workspace.projection, session.id, session.engine.transcript);
}

function persistWorkspaceContext(workspace) {
  workspace.tabPersistence?.observe(workspace._savePoolForBroker(), workspace._tasksForBroker());
  workspace.onChange();
}

export function requestConversationClear(workspace) {
  const session = workspace.projection.active();
  if (!session) throw new ContractError('session_missing', 'conversation is no longer available');
  session.confirmClear = true;
  workspace.projection.showNotice(CONTEXT_NOTICE, 'This removes the active conversation context. Confirm with /confirm clear conversation.');
  workspace.onChange();
}

export async function confirmConversationClear(workspace) {
  const projected = workspace.projection.active();
  if (!projected?.confirmClear) throw new ContractError('clear_confirmation_missing', 'request /clear conversation before confirming');
  const result = await clearWorkspaceConversation(workspace, projected.id, { notice: true });
  projected.confirmClear = false;
  return result;
}

export async function clearWorkspaceConversation(workspace, sessionId, options = {}) {
  const projected = requireProjectedSession(workspace, sessionId);
  const session = requireEngineSession(workspace, sessionId);
  const result = await session.engine.clearConversation();
  resetProjectedTranscript(workspace, projected, session);
  projected.contextBytes = 0;
  projected.contextTokens = 0;
  projected.confirmClear = false;
  if (options.notice) workspace.projection.showNotice(CONTEXT_NOTICE, `Cleared ${result.removed} context records from this conversation.`);
  persistWorkspaceContext(workspace);
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
