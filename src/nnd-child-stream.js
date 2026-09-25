// SPDX-License-Identifier: Apache-2.0

const LIVE_PREVIEW_LIMIT_CHARS = 262_144;

export function childLiveMessage(child, state) {
  return { info: { id: state.messageId, sessionID: child.id, role: 'assistant',
    time: { created: child.time.created }, agent: 'nna', model: { providerID: 'nna', modelID: 'nna' } },
  parts: [{ id: `${state.messageId}:text`, sessionID: child.id, messageID: state.messageId,
    type: 'text', text: state.preview }] };
}

export function streamChildDelta(child, state, text, publish) {
  const remaining = LIVE_PREVIEW_LIMIT_CHARS - state.streamedChars;
  const preview = remaining > 0 ? text.slice(0, remaining) : '';
  if (preview) {
    const partId = `${state.messageId}:text`;
    if (!state.opened) {
      state.opened = true;
      publish('message.updated', { sessionID: child.id, info: childLiveMessage(child, state).info });
      publish('message.part.updated', { sessionID: child.id, part: {
        id: partId, sessionID: child.id, messageID: state.messageId, type: 'text', text: preview,
      } });
    } else publish('message.part.delta', { sessionID: child.id,
      messageID: state.messageId, partID: partId, field: 'text', delta: preview });
    state.preview += preview;
    state.streamedChars += preview.length;
  }
  if (preview.length < text.length && !state.previewLimited) {
    state.previewLimited = true;
    publish('nnd.activity', { id: `${child.id}:preview`, sessionID: child.id,
      kind: 'notice', status: 'redacted', summary: 'Live preview limit reached; the full transcript will appear when the turn completes', time: Date.now() });
  }
}
