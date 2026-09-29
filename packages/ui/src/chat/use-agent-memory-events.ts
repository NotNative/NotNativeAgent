// SPDX-License-Identifier: Apache-2.0
/** Memory panel refresh trigger; the event is a signal, not writable state. */
import { useEffect, useState } from 'react';
import { agentMemoryChange, AGENT_MEMORY_CHANGED } from '../lib/agent-memory-events.ts';
import { subscribeControlEvents } from '../lib/nnd/events.ts';

export function useAgentMemoryChange(projectId: string, visible: boolean,
  onChange: (event: { scope: 'global' | 'project'; projectId?: string }) => void): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!visible || typeof window === 'undefined' || !('EventSource' in window)) return;
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void subscribeControlEvents((event) => {
      if (!active || event.type !== AGENT_MEMORY_CHANGED) return;
      const change = agentMemoryChange(event.properties);
      if (change && (change.scope === 'global' || change.projectId === projectId)) {
        setRevision((current) => current + 1);
        onChange(change);
      }
    }).then((stop) => {
      if (!active) stop();
      else unsubscribe = stop;
    });
    return () => {
      active = false;
      if (unsubscribe) unsubscribe();
    };
  }, [onChange, projectId, visible]);
  return revision;
}
