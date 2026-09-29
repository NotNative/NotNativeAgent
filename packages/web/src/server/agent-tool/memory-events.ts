// SPDX-License-Identifier: Apache-2.0
/** Bounded memory-change fan-out for the live control stream. */
import { publishControlEvent } from '../lib/bus.ts';
import { CONTROL_EVENTS } from '../lib/harnessNaming.ts';
import type { AgentMemoryScope } from '../project-context/agent-memory.ts';

export function announceAgentMemoryChange(event: { scope: AgentMemoryScope; projectId?: string }): void {
  publishControlEvent({ type: CONTROL_EVENTS.agentMemoryChanged, payload: {
    scope: event.scope, ...(event.projectId === undefined ? {} : { projectId: event.projectId }),
  } });
}
