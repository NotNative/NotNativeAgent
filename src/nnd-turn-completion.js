// SPDX-License-Identifier: Apache-2.0
import { turnActivity } from './nnd-child-stream.js';
import { describe, nextUpdatedAt } from './nnd-session-description.js';

/** Settle the host's display state even when its transcript projection is unavailable. */
export function publishNndTurnCompletion(context, turn, rejected, { messages, publish, activity, commitCatalogChange }) {
  if (context.closing) return;
  try {
    try {
      if (turn.opened) publish('message.removed', { sessionID: context.sessionId, messageID: turn.messageId }, true);
      for (const entry of messages(context.sessionId,
        { subjectId: context.subjectId, workspaceIds: [...context.workspaceIds] })) {
        publish('message.updated', { sessionID: context.sessionId, info: entry.info }, true);
        for (const part of entry.parts) publish('message.part.updated', { sessionID: context.sessionId, part }, true);
      }
    } catch (error) { reportNndCompletionFailure(context, error, 'completion_projection'); }
    try {
      const result = turnActivity(turn.outcome, rejected);
      activity(turn.activityId, 'turn', result.status, result.summary, turn.requestId, undefined, result.turnOutcome);
    } catch (error) { reportNndCompletionFailure(context, error, 'completion_activity'); }
  } finally {
    if (context.liveTurn === turn) {
      // Invariant: projection failure cannot hold a completed engine turn busy.
      context.liveTurn = null;
      context.turnState = 'idle';
      context.updatedAt = nextUpdatedAt(context);
      safePublish(context, publish, 'session.status',
        { sessionID: context.sessionId, status: { type: 'idle' } });
      safePublish(context, publish, 'session.idle', { sessionID: context.sessionId });
    }
  }
  try { publish('session.updated', { sessionID: context.sessionId, info: describe(context) }, true); }
  catch (error) { reportNndCompletionFailure(context, error, 'completion_description'); }
  if (context.contextUsage) {
    try {
      void commitCatalogChange().catch((error) => {
        if (context.closing) return;
        try { activity(`${context.sessionId}:context-save:${turn.requestId}`,
          'notice', 'failed', 'Context estimate could not be saved'); }
        catch (activityError) { reportNndCompletionFailure(context, activityError, 'completion_context_notice'); }
        reportNndCompletionFailure(context, error, 'completion_context_save');
      });
    } catch (error) { reportNndCompletionFailure(context, error, 'completion_context_save'); }
  }
}

export function reportNndCompletionFailure(context, error, stage) {
  try { context.engine.telemetry?.record('nnd.event_delivery', 'failed', {
    event_type: stage, code: error?.code ?? 'event_delivery_failed',
  }); } catch { /* Display diagnostics cannot replace the engine outcome. */ }
}

function safePublish(context, publish, type, properties) {
  try { publish(type, properties); }
  catch (error) { reportNndCompletionFailure(context, error, type); }
}
