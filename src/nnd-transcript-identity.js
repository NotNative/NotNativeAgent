// SPDX-License-Identifier: Apache-2.0

/** Journal positions are stable even when the public message window rolls forward. */
export function messageProjection(context, item, index) {
  // Submitted user IDs reconcile optimistic NND rows across journal replay.
  const messageId = item.role === 'user' && item.requestId ? item.requestId : `${context.sessionId}:message:${index}`;
  const created = context.createdAt + index;
  // Only the separate live preview is unfinished; journaled replies are settled.
  const time = item.role === 'assistant' ? { created, completed: created } : { created };
  return { info: { id: messageId, sessionID: context.sessionId, role: item.role, time, agent: 'nna', model: { providerID: 'nna', modelID: 'nna' } }, parts: [{ id: `${context.sessionId}:part:${index}`, sessionID: context.sessionId, messageID: messageId, type: 'text', text: item.content }] };
}

export function reservedProjectedMessageId(sessionId, requestId) {
  const prefix = `${sessionId}:message:`;
  return requestId.startsWith(prefix) && /^\d+$/u.test(requestId.slice(prefix.length));
}

/** Reverse scan makes recent retries cheap without losing older durable identities. */
export function hasPersistedSubmission(transcript, requestId) {
  return Array.isArray(transcript) && transcript.findLast((item) => item?.type === 'message'
    && item.role === 'user' && item.requestId === requestId) !== undefined;
}
