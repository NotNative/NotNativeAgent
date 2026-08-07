// SPDX-License-Identifier: Apache-2.0
import { userDataPaths } from './product.js';
import { ConsoleSessionBroker } from './session-broker.js';
import { ContractError, newId } from './ids.js';
import { clearWorkspaceConversation, compactWorkspaceConversation } from './workspace-context.js';

export async function initializeWorkspaceSessionBroker(workspace) {
  if (workspace.sessionBroker) return workspace.sessionBroker;
  const paths = workspace.options.dataPaths ?? userDataPaths();
  const factory = workspace.options.sessionBrokerFactory ?? ((owner) => new ConsoleSessionBroker(owner, {
    root: paths.sessionBrokers ?? userDataPaths().sessionBrokers,
  }));
  workspace.sessionBroker = await factory(workspace).start();
  return workspace.sessionBroker;
}

export function workspaceBrokerSessions(workspace) {
  return [...workspace.sessions.values()].map((session) => ({
    id: session.id, alias: alias(session.name), name: session.name,
    summary: summary(session.engine.transcript),
    active: session.id === workspace.projection.activeId,
    busy: session.engine.state.state !== 'idle',
  }));
}

export async function submitWorkspaceSession(workspace, sessionId, content) {
  const session = requireSession(workspace, sessionId);
  if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content, 'utf8') > 262_144) {
    throw new ContractError('broker_content_invalid', 'attached message is empty or too large');
  }
  session.meaningful = true;
  workspace.projection.apply(session.id, { type: 'user_input', text: content });
  workspace.tabPersistence.observe(workspace._savePoolForBroker(), workspace._tasksForBroker());
  workspace.onChange();
  return session.ingress.submit({
    version: '1.0', type: 'submit', request_id: newId('telegram_attach'), content,
  }, 'authenticated-telegram-attachment');
}

export function cancelWorkspaceSession(workspace, sessionId) {
  const session = requireSession(workspace, sessionId);
  return session.ingress.submit({
    version: '1.0', type: 'cancel', request_id: newId('telegram_attach_cancel'),
  }, 'authenticated-telegram-attachment');
}

export function compactWorkspaceSession(workspace, sessionId) {
  return compactWorkspaceConversation(workspace, sessionId);
}

export function clearWorkspaceSession(workspace, sessionId) {
  return clearWorkspaceConversation(workspace, sessionId);
}

function requireSession(workspace, id) {
  const session = workspace.sessions.get(id);
  if (!session) throw new ContractError('session_missing', 'attached conversation is no longer available');
  return session;
}
function alias(name) { return String(name ?? 'Conversation').replace(/[^A-Za-z0-9_-]/gu, '').slice(0, 24) || 'Conversation'; }
function summary(transcript) {
  const messages = (transcript ?? []).filter((item) => item.type === 'message' && typeof item.content === 'string');
  const last = messages.at(-1)?.content?.replace(/\s+/gu, ' ').trim();
  if (!last) return 'New conversation';
  return last.length > 112 ? `${last.slice(0, 109)}...` : last;
}
