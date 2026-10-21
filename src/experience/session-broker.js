// SPDX-License-Identifier: Apache-2.0
import { userDataPaths } from '../product.js';
import { ConsoleSessionBroker } from '../session-broker.js';
import { ContractError, newId } from '../ids.js';
import { clearWorkspaceConversation, compactWorkspaceConversation, handoffWorkspaceConversation } from './context.js';
import { beginSessionSubmission } from './submission.js';
import { fenceGatewayRequests, gatewayFences, withGatewayAdmission } from './gateway-admission.js';

const MAX_ATTACHED_MESSAGE_BYTES = 262_144;
const ATTACHED_PRINCIPAL = 'authenticated-telegram-attachment';

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
  requireWorkspaceProjection(workspace);
  return [...workspace.sessions.values()].map((session) => ({
    id: session.id, alias: alias(session.name), name: session.name,
    summary: summary(requireEngine(session).transcript),
    active: session.id === workspace.projection.activeId,
    busy: session.engine.state.state !== 'idle',
    turn_id: session.engine.active?.turnId ?? null,
  }));
}

export async function submitWorkspaceSession(workspace, sessionId, content, requestId) {
  const session = requireSession(workspace, sessionId);
  requireWorkspaceProjection(workspace);
  if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content, 'utf8') > MAX_ATTACHED_MESSAGE_BYTES) {
    throw new ContractError('broker_content_invalid', 'attached message is empty or too large');
  }
  if (!requestId?.startsWith('gateway_update_')) {
    if (requestId && session.pendingSubmission?.requestId !== requestId
      && await previouslyAcceptedRequest(session, requestId)) {
      return { accepted: false, duplicate: true, pending: false };
    }
    return beginSessionSubmission(workspace, session, content, {
      principal: ATTACHED_PRINCIPAL, requestPrefix: 'telegram_attach', requestId,
    });
  }
  const { operation } = await withGatewayAdmission(session, async () => {
    if (requestId && (await gatewayFences(session)).has(requestId)) {
      return { operation: Promise.resolve({ accepted: false, cancelled: true }) };
    }
    if (requestId && session.pendingSubmission?.requestId !== requestId
      && await previouslyAcceptedRequest(session, requestId)) {
      return { operation: Promise.resolve({ accepted: false, duplicate: true, pending: false }) };
    }
    return { operation: beginSessionSubmission(workspace, session, content, {
      principal: ATTACHED_PRINCIPAL, requestPrefix: 'telegram_attach', requestId,
    }) };
  });
  return operation;
}

async function previouslyAcceptedRequest(session, requestId) {
  if (typeof session.engine.store?.readRecords !== 'function') return false;
  if (!session.durableAcceptedRequestIds) {
    session.durableRequestIdLoading ??= session.engine.store.readRecords().then(({ records }) => new Set(
      records.filter((record) => record.type === 'turn_accepted' && typeof record.payload?.requestId === 'string')
        .map((record) => record.payload.requestId),
    )).finally(() => { session.durableRequestIdLoading = null; });
    session.durableAcceptedRequestIds = await session.durableRequestIdLoading;
  }
  // Invariant: a gateway retry of a committed turn cannot start a second turn after restart.
  return session.durableAcceptedRequestIds.has(requestId);
}

export async function cancelWorkspaceSession(workspace, sessionId, expectedTurnId, fenceRequestIds = []) {
  const session = requireSession(workspace, sessionId);
  const matchedTurn = await withGatewayAdmission(session, async () => {
    await fenceGatewayRequests(session, fenceRequestIds);
    const active = session.engine.active;
    return active && fenceRequestIds.includes(active.requestId) ? active.turnId : null;
  });
  const targetTurn = matchedTurn ?? expectedTurnId;
  if (!targetTurn && fenceRequestIds.length > 0) return { accepted: true, already_terminal: true };
  const result = await session.ingress.submit({
    version: '1.0', type: 'cancel', request_id: newId('telegram_attach_cancel'),
    ...(targetTurn ? { expected_turn_id: targetTurn } : {}),
  }, ATTACHED_PRINCIPAL);
  return result;
}

export function compactWorkspaceSession(workspace, sessionId) {
  return compactWorkspaceConversation(workspace, sessionId);
}

export function handoffWorkspaceSession(workspace, sessionId) {
  return handoffWorkspaceConversation(workspace, sessionId);
}

export function clearWorkspaceSession(workspace, sessionId) {
  return clearWorkspaceConversation(workspace, sessionId);
}

function requireSession(workspace, id) {
  if (!(workspace?.sessions instanceof Map)) throw new ContractError('session_broker_unavailable', 'attached conversation registry is unavailable');
  const session = workspace.sessions.get(id);
  if (!session) throw new ContractError('session_missing', 'attached conversation is no longer available');
  requireEngine(session);
  if (typeof session.ingress?.submit !== 'function') {
    throw new ContractError('session_broker_unavailable', 'attached conversation ingress is unavailable');
  }
  return session;
}
function requireEngine(session) {
  if (!session?.engine || !Array.isArray(session.engine.transcript) || typeof session.engine.state?.state !== 'string') {
    throw new ContractError('session_broker_unavailable', 'attached conversation runtime is unavailable');
  }
  return session.engine;
}
function requireWorkspaceProjection(workspace) {
  if (!workspace?.projection || typeof workspace.projection.apply !== 'function') {
    throw new ContractError('session_broker_unavailable', 'attached conversation projection is unavailable');
  }
}
function alias(name) { return String(name ?? 'Conversation').replace(/[^A-Za-z0-9_-]/gu, '').slice(0, 24) || 'Conversation'; }
function summary(transcript) {
  const messages = (transcript ?? []).filter((item) => item.type === 'message' && typeof item.content === 'string');
  const last = messages.at(-1)?.content?.replace(/\s+/gu, ' ').trim();
  if (!last) return 'New conversation';
  return last.length > 112 ? `${last.slice(0, 109)}...` : last;
}
