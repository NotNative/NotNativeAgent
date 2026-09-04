// SPDX-License-Identifier: Apache-2.0
import { manifestFromConfig } from '../provider/route-configuration.js';
import { ContractError } from '../ids.js';
import { isReviewPosture } from '../review-posture.js';

export function tabPoolRecords(sessions, projection) {
  return [...sessions.values()].map((session) => {
    if (!session?.sessionId || !session.engine) throw invalidPresentation('engine session');
    const projected = projection?.sessions?.get(session.sessionId);
    return {
      sessionId: session.sessionId, name: session.name,
      nameLocked: session.nameLocked === true, autoNamed: session.autoNamed === true,
      main: session.main === true,
      role: projected?.role ?? 'standard', meaningful: session.meaningful,
      manifest: manifestFromConfig(session.engine.pendingConfig ?? session.engine.config),
      presentation: presentationState(projected),
    };
  });
}

export function presentationState(session) {
  if (!session?.editor || !Array.isArray(session.pendingAttachments)
    || !(session.expandedTurns instanceof Set) || !(session.detailedTurns instanceof Set)) {
    throw invalidPresentation('projected session');
  }
  return {
    draft: session.editor.text, viewport_end: session.viewportEnd,
    expanded_turn_ids: [...session.expandedTurns], review_posture: session.reviewPosture,
    detailed_turn_ids: [...session.detailedTurns],
    work_collapsed: session.workCollapsed === true,
    pending_attachments: session.pendingAttachments.map((item) => ({ ...item })),
  };
}

export function restorePresentation(session, engine, value) {
  if (!value) return;
  if (typeof session?.editor?.set !== 'function' || !engine) throw invalidPresentation('restore target');
  if (typeof value.draft !== 'string' || !Array.isArray(value.expanded_turn_ids)
    || (value.viewport_end != null && (!Number.isSafeInteger(value.viewport_end) || value.viewport_end < 0))
    || (value.detailed_turn_ids !== undefined && !Array.isArray(value.detailed_turn_ids))
    || !Array.isArray(value.pending_attachments)
    || !isReviewPosture(value.review_posture)) throw invalidPresentation('saved state');
  session.editor.set(value.draft);
  session.viewportEnd = value.viewport_end ?? null;
  session.expandedTurns = new Set(value.expanded_turn_ids ?? []);
  session.detailedTurns = new Set(value.detailed_turn_ids ?? []);
  session.workCollapsed = value.work_collapsed === true;
  session.reviewPosture = value.review_posture;
  session.pendingAttachments = value.pending_attachments.map((item) => Object.freeze({ ...item }));
  engine.reviewPosture = value.review_posture;
}

function invalidPresentation(subject) {
  return new ContractError('presentation_state_invalid', `${subject} presentation state is unavailable or malformed`);
}
