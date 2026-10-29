// SPDX-License-Identifier: Apache-2.0
import { ContractError, requireExternalId } from './ids.js';
import { requirePrincipal } from './desktop-session-helpers.js';
import { messageProjection } from './desktop-transcript-identity.js';
import { childLiveMessage } from './desktop-child-stream.js';

export function desktopMessages(sessionId, principal, context, childSessions, childStreams, all) {
  requireExternalId(sessionId, 'session_id'); requirePrincipal(principal);
  if (!context) {
    const child = childSessions.get?.(sessionId, principal);
    const entries = childSessions.messages?.(sessionId, principal);
    if (!child || !entries) throw new ContractError('desktop_session_unavailable', 'desktop session context is unavailable');
    const messages = entries.map(({ item, index }) => messageProjection({ sessionId, createdAt: child.time.created }, item, index));
    const live = childStreams.get(sessionId);
    if (live?.opened) messages.push(childLiveMessage(child, live));
    return messages;
  }
  return context.engine.transcript
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item?.type === 'message' && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string')
    .slice(all ? 0 : -200)
    .map(({ item, index }) => messageProjection(context, item, index));
}
