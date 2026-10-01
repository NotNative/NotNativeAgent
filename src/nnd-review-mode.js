// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { nextUpdatedAt } from './nnd-session-description.js';

export const NND_REVIEW_MODES = Object.freeze(['default', 'auto-review', 'unattended']);
export function reviewModeSnapshot(context) {
  return { mode: context.reviewMode, effective: context.engine.reviewPosture,
    revision: context.reviewRevision, availableModes: [...NND_REVIEW_MODES], defaultMode: 'auto-review' };
}

export async function commitReviewMode(context, body, commitCatalog, publish) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== 2 || !NND_REVIEW_MODES.includes(body.mode)
    || !Number.isSafeInteger(body.expected_revision) || body.expected_revision < 0) {
    throw new ContractError('review_posture_invalid', 'review mode request is invalid');
  }
  context.reviewArming = (context.reviewArming ?? 0) + 1;
  try {
    let revision; let updatedAt;
    await commitCatalog((contexts) => {
      if (context.closing || contexts.get(context.sessionId) !== context
        || context.liveTurn || context.engine.active && !context.engine.active.finalized) {
        throw new ContractError('nnd_session_unavailable', 'review mode can change only while the session is idle');
      }
      if (context.reviewRevision !== body.expected_revision) {
        throw new ContractError('nnd_session_unavailable', 'review mode changed; refresh before writing');
      }
      revision = context.reviewRevision + 1;
      updatedAt = nextUpdatedAt(context);
      contexts.set(context.sessionId, { ...context, reviewMode: body.mode, reviewRevision: revision, updatedAt });
    }, () => {
      context.reviewMode = body.mode;
      context.reviewRevision = revision;
      context.updatedAt = updatedAt;
      context.engine.reviewPosture = body.mode === 'default' ? 'auto-review' : body.mode;
    });
    publish();
    return reviewModeSnapshot(context);
  } finally { context.reviewArming -= 1; }
}
