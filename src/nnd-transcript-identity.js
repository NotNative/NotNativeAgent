// SPDX-License-Identifier: Apache-2.0

/** Journal positions are stable even when the public message window rolls forward. */
export function messageProjection(context, item, index) {
  // Submitted user IDs reconcile optimistic NND rows across journal replay.
  const messageId = item.role === 'user' && item.requestId ? item.requestId : `${context.sessionId}:message:${index}`;
  const created = context.createdAt + index;
  // Only the separate live preview is unfinished; journaled replies are settled.
  const time = item.role === 'assistant' ? { created, completed: created } : { created };
  const parts = [{ id: `${context.sessionId}:part:${index}`, sessionID: context.sessionId,
    messageID: messageId, type: 'text', text: item.content }];
  const files = item.role === 'user' && Array.isArray(item.attachmentDisplay)
    ? item.attachmentDisplay.slice(0, 16) : [];
  for (const [position, file] of files.entries()) {
    if (!file || typeof file.filename !== 'string' || file.filename.length < 1 || file.filename.length > 255
      || /[\\/:*?"<>|\u0000-\u001f\u007f]/u.test(file.filename)
      || typeof file.mime !== 'string' || file.mime.length < 1 || file.mime.length > 128) continue;
    parts.push({ id: `${context.sessionId}:part:${index}:file:${position}`, sessionID: context.sessionId,
      messageID: messageId, type: 'file', filename: file.filename, mime: file.mime, url: '' });
  }
  return { info: { id: messageId, sessionID: context.sessionId, role: item.role, time, agent: 'nna', model: { providerID: 'nna', modelID: 'nna' } }, parts };
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
