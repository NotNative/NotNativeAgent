// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';

/** A parent sees delegated lifecycle, never the child's private output here. */
export function parentChildActivity(type, child, parentID, payload, turnRequestID) {
  const lifecycle = type === 'registered' ? { status: 'started', summary: 'Subagent created' }
    : type === 'started' ? { status: 'started', summary: 'Subagent working' }
      : type === 'completed' ? payload?.outcome === 'needs_input'
        ? { status: 'attention', summary: 'Subagent needs input' }
        : payload?.outcome === 'completed' ? { status: 'completed', summary: 'Subagent completed' }
          : payload?.outcome === 'cancelled' ? { status: 'completed', summary: 'Subagent cancelled' }
            : payload?.outcome ? { status: 'failed', summary: 'Subagent failed' }
              : { status: 'completed', summary: 'Subagent stopped' } : null;
  if (!lifecycle) return null;
  return { id: `${parentID}:child:${randomUUID()}`, sessionID: parentID,
    kind: 'subagent', ...lifecycle, childSessionID: child.id, time: Date.now(),
    ...(turnRequestID ? { evidenceMessageID: turnRequestID } : {}) };
}
