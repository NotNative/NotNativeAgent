// SPDX-License-Identifier: Apache-2.0
/** Native timeline fork orchestration: validate the boundary, derive the
 *  parent journal prefix, and create the child session that seeds it. */
import { ContractError, newId } from './ids.js';
import { titleOf } from './nnd-session-description.js';
import { modelRouteFromBody } from './nnd-session-model-route.js';
import { forkPrefixRecords, resolveForkBoundary } from './persistence/fork-records.js';

export async function runNndSessionFork(context, callbacks, body) {
  if (!context.engine.store) throw new ContractError('nnd_fork_unavailable', 'NND fork requires a durable session journal');
  if (context.closing || context.liveTurn || context.engine.active && !context.engine.active.finalized) {
    throw new ContractError('nnd_fork_busy', 'NND session is busy');
  }
  // Compatibility: sidebar forks omit a boundary and include the settled timeline.
  const timeline = context.engine.transcript;
  const latest = body?.messageID === undefined ? timeline.findLastIndex(item => item?.type === 'message'
    && ['user', 'assistant'].includes(item.role) && item.turnId) : -1;
  const boundary = body?.messageID === undefined && latest >= 0
    ? `${context.sessionId}:message:${latest}` : body?.messageID;
  const { turnId, messageId } = resolveForkBoundary(timeline, context.sessionId, boundary);
  const { records } = await context.engine.store.readRecords();
  const prefix = forkPrefixRecords(records, turnId);
  const childId = newId('ses');
  const modelRoute = modelRouteFromBody(body) ?? context.modelRoute;
  const options = { directory: context.directory, title: titleOf(context.title) ? `${context.title} (fork)` : 'Forked session',
    ...(context.workspaceBinding ? { workspace_id: context.workspaceBinding.id } : {}),
    ...(modelRoute ? { modelRoute } : {}),
    forkIngest: { records: prefix, sourceSessionId: context.sessionId, boundaryMessageId: messageId },
    reviewMode: context.reviewMode };
  await callbacks.createContext(childId, options);
  return callbacks.get(childId);
}
