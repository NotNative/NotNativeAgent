// SPDX-License-Identifier: Apache-2.0
import { manifestFromConfig } from '../route-configuration.js';

export function tabPoolRecords(sessions, projection) {
  return [...sessions.values()].map((session) => ({
    sessionId: session.sessionId, name: session.name,
    main: session.main === true,
    role: projection.sessions.get(session.id)?.role ?? 'standard', meaningful: session.meaningful,
    manifest: manifestFromConfig(session.engine.pendingConfig ?? session.engine.config),
    presentation: presentationState(projection.sessions.get(session.id)),
  }));
}

export function presentationState(session) {
  return {
    draft: session.editor.text, viewport_end: session.viewportEnd,
    expanded_turn_ids: [...session.expandedTurns], review_posture: session.reviewPosture,
    detailed_turn_ids: [...session.detailedTurns],
    work_collapsed: session.workCollapsed === true,
    pending_attachments: session.pendingAttachments,
  };
}

export function restorePresentation(session, engine, value) {
  if (!value) return;
  session.editor.set(value.draft);
  session.viewportEnd = value.viewport_end;
  session.expandedTurns = new Set(value.expanded_turn_ids ?? []);
  session.detailedTurns = new Set(value.detailed_turn_ids ?? []);
  session.workCollapsed = value.work_collapsed === true;
  session.reviewPosture = value.review_posture;
  session.pendingAttachments = value.pending_attachments.map((item) => Object.freeze({ ...item }));
  engine.reviewPosture = value.review_posture;
}
