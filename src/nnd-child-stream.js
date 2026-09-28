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

/** Translate one delegated lifecycle record into child-scoped display frames. */
export function observeChildLifecycle({ type, child, payload, streams, activity, publish, messages }) {
  const state = streams.get(child.id);
  if (type === 'registered') {
    activity.set(child.id, []);
    streams.set(child.id, { messageId: `${child.id}:live`, opened: false, preview: '', streamedChars: 0,
      previewLimited: false, turnId: null, outcome: null });
    publish('session.created', { info: child }, true);
  } else if (type === 'started') {
    publish('session.status', { sessionID: child.id, status: { type: 'busy' } });
    publish('nnd.activity', { id: `${child.id}:turn:start`, sessionID: child.id,
      kind: 'turn', status: 'started', summary: 'Subagent turn started', time: Date.now() });
  } else if (type === 'phase') {
    publish('session.updated', { sessionID: child.id, info: child }, true);
  } else if (type === 'output' && state && payload) {
    if (payload.turn_id) {
      if (state.turnId && state.turnId !== payload.turn_id) return;
      state.turnId ??= payload.turn_id;
    }
    if (payload.type === 'stream_delta' && typeof payload.text === 'string' && payload.text) {
      streamChildDelta(child, state, payload.text, publish);
    } else if (payload.type === 'tool_status' && typeof payload.tool === 'string' && typeof payload.status === 'string') {
      const toolId = payload.tool_request_id ?? payload.provider_call_id;
      if (typeof toolId === 'string' && toolId) publish('nnd.activity', {
        id: activityStatus(payload.status) === 'started' ? `${child.id}:ts:${toolId}` : `${child.id}:tool:${toolId}`,
        sessionID: child.id, kind: 'tool', status: activityStatus(payload.status),
        summary: `${payload.tool}: ${payload.status}`, time: Date.now(), toolEvidence: payload,
      });
    } else if (payload.type === 'turn_result') state.outcome = payload.outcome;
  } else if (type === 'completed') {
    streams.delete(child.id);
    if (state?.opened) publish('message.removed', { sessionID: child.id, messageID: state.messageId }, true);
    for (const entry of messages()) {
      publish('message.updated', { sessionID: child.id, info: entry.info }, true);
      for (const part of entry.parts) publish('message.part.updated', { sessionID: child.id, part }, true);
    }
    const result = turnActivity(state?.outcome ?? payload?.outcome, false);
    publish('nnd.activity', { id: `${child.id}:turn`, sessionID: child.id,
      kind: 'turn', status: result.status, summary: result.summary, time: Date.now() });
    publish('session.status', { sessionID: child.id, status: { type: 'idle' } });
    publish('session.idle', { sessionID: child.id });
    publish('session.updated', { sessionID: child.id, info: child }, true);
  } else if (type === 'deleted') {
    activity.delete(child.id);
    streams.delete(child.id);
    publish('session.deleted', { sessionID: child.id }, true);
  }
}

export function activityStatus(value) {
  if (value === 'succeeded' || value === 'duplicate_ignored') return 'completed';
  if (value === 'review_pending' || value === 'approved' || value === 'running') return 'started';
  return 'failed';
}
export function turnActivity(outcome, rejected) {
  if (rejected) return { status: 'failed', summary: 'Turn failed' };
  if (outcome === 'cancelled') return { status: 'completed', summary: 'Turn cancelled' };
  if (outcome === 'needs_input') return { status: 'attention', summary: 'Turn needs input' };
  if (outcome && outcome !== 'completed') return { status: 'failed', summary: 'Turn failed' };
  return { status: 'completed', summary: 'Turn completed' };
}
