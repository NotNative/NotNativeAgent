// SPDX-License-Identifier: Apache-2.0
import type { HarnessEvent } from '../lib/nnd/events.ts';
import type { SyncState } from './types.ts';
import type { ReducerApi } from './reducer-core.ts';
import { applyNnaProjection, parseNnaProjection, sessionProjection, staleProjection } from './nna-projection.ts';

export function applyProjectionEvent(draft: SyncState, event: HarnessEvent, api: ReducerApi): boolean {
  if (event.type !== 'nnd.projection') return false;
  const frame = parseNnaProjection(event.properties?.frame);
  if (!frame || frame.sessionID !== event.properties?.sessionID) return true;
  const index = draft.session.findIndex((session) => session.id === frame.sessionID);
  const current = draft.session[index];
  if (!current || current.time.archived || staleProjection(sessionProjection(current), frame, true)) return true;
  api.ensure('session'); draft.session[index] = applyNnaProjection(current, frame);
  api.ensure('sessionRevision'); api.ensure('sessionEventRevision');
  draft.sessionRevision += 1; draft.sessionEventRevision[frame.sessionID] = draft.sessionRevision;
  api.changed(); return true;
}
