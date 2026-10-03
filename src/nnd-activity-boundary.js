// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { readOwnedActivityPage } from './nnd-activity-history.js';
import { directoryFor } from './nnd-session-description.js';

/** Pair a byte-identical durable Activity suffix with a later SSE checkpoint. */
export async function readActivityPageWithBoundary(catalogPath, context, options, currentContext, eventBus) {
  const page = await readOwnedActivityPage(catalogPath, context, options, currentContext);
  const present = page.snapshot.durablePresent;
  const digest = createHash('sha256').update(JSON.stringify([
    context.sessionId, context.createdAt, present, context.activity,
  ])).digest('hex');
  const sameSnapshot = page.status === 'page' && digest === page.snapshot.digest
    && (present || context.activity.length === 0);
  const scope = { directory: directoryFor(context), sessionID: context.sessionId,
    project: context.workspaceIds.values().next().value, subjectId: context.subjectId,
    workspaceIds: [...context.workspaceIds] };
  const cursor = sameSnapshot ? eventBus.checkpointSession?.(scope) : null;
  return { ...page, liveBoundary: cursor
    ? { status: 'paired', sessionID: context.sessionId, cursor }
    : { status: 'gap', sessionID: context.sessionId, cursor: null,
      reason: page.status === 'gap' ? page.reason : sameSnapshot ? 'replay_unavailable' : 'durable_snapshot_behind_live' } };
}
