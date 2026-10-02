// SPDX-License-Identifier: Apache-2.0
import { newId } from './ids.js';

/** Versioned display snapshot; epochs distinguish restored engine contexts. */
export function nndProjection(context, nnd) {
  const state = { turnState: nnd.turnState ?? null, activeTools: nnd.activeTools ?? null, context: nnd.context ?? null };
  const digest = JSON.stringify(state);
  if (!context.projection || context.projectionDigest !== digest) {
    context.projectionDigest = digest;
    context.projection = Object.freeze({ version: '1.0', sessionID: context.sessionId,
      epoch: context.projection?.epoch ?? newId('projection'), revision: (context.projection?.revision ?? 0) + 1,
      updatedAt: context.updatedAt, ...state });
  }
  return context.projection;
}

/** Security: use the identical owner/workspace envelope for snapshots and their replay frames. */
export function publishNndProjection(bus, event) {
  const delivered = bus.publishSession(event);
  const frame = event.properties?.info?.metadata?.nnd?.projection;
  if (frame && ['session.created', 'session.updated'].includes(event.type)) {
    bus.publishSession({ ...event, type: 'nnd.projection', mirror: false,
      properties: { sessionID: event.sessionID, frame } });
  }
  return delivered;
}
