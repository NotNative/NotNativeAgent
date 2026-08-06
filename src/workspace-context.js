// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { restoreTranscript } from './workspace-transcript.js';

export async function compactActiveConversation(workspace) {
  const projected = workspace.projection.active();
  const session = workspace.sessions.get(projected.id);
  const result = await session.engine.compactConversation();
  projected.records = [];
  projected.expandedTurns.clear();
  projected.detailedTurns.clear();
  restoreTranscript(workspace.projection, session.id, session.engine.transcript);
  workspace.projection.showNotice('context', `Compaction omitted ${result.omitted} settled records and retained ${result.retained}.`);
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
  const session = workspace.sessions.get(projected.id);
  const result = await session.engine.clearConversation();
  projected.records = [];
  projected.expandedTurns.clear();
  projected.detailedTurns.clear();
  projected.contextBytes = 0;
  projected.confirmClear = false;
  workspace.projection.showNotice('context', `Cleared ${result.removed} context records from this conversation.`);
  workspace.onChange();
  return result;
}
