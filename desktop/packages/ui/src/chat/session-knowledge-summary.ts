// SPDX-License-Identifier: Apache-2.0
/** Work-status summary cache for server-owned session knowledge (doc 15 §B.9). */
import { useCallback, useEffect, useState } from 'react';
import {
  pinSessionKnowledge, getSessionKnowledgeSummary,
  type SessionKnowledgeSummary,
} from '../lib/session-knowledge-api.ts';
import { normalizeDirectory } from '../lib/nnd/client.ts';

const SUMMARY_TTL_MS = 5000;

type CacheEntry = { value: SessionKnowledgeSummary; at: number };
type SummaryState = CacheEntry | undefined;
const summaries = new Map<string, CacheEntry>();
const SUMMARY_CACHE_LIMIT = 100;

export interface KnowledgeUnpinInput {
  directory: string;
  sessionID: string;
  kind: 'note' | 'plan';
  id: string;
}

export function useSessionKnowledgeSummary(input: {
  directory: string;
  sessionID: string;
}): {
  summary: SessionKnowledgeSummary | undefined;
  unavailable: boolean;
  unpin: (input: Omit<KnowledgeUnpinInput, 'directory' | 'sessionID'>) => Promise<void>;
} {
  const key = `${normalizeDirectory(input.directory)}\0${input.sessionID}`;
  const [state, setState] = useState<SummaryState>(() => freshCache(key));
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let active = true;
    if (!input.directory || !input.sessionID) {
      summaries.delete(key);
      setState(undefined);
      setUnavailable(false);
      return () => { active = false; };
    }
    setState(freshCache(key));
    const load = async (): Promise<void> => {
      try {
        const value = await getSessionKnowledgeSummary(input.directory, input.sessionID);
        if (!active) return;
        const entry = { value, at: Date.now() };
        trimCache(key);
        summaries.set(key, entry);
        setUnavailable(false);
        setState(entry);
      } catch {
        if (active) {
          setUnavailable(true);
          setState(undefined);
        }
      }
    };
    void load();
    return () => { active = false; };
  }, [input.directory, input.sessionID, key]);

  const unpin = useCallback(async (target: Omit<KnowledgeUnpinInput, 'directory' | 'sessionID'>): Promise<void> => {
    const pins = await pinSessionKnowledge({
      sessionId: input.sessionID, directory: input.directory,
      kind: target.kind, id: target.id, pinned: false,
    });
    const previous = state?.value ?? { notes: [], plans: [], memory: { global: 0, project: 0 } };
    const next: SessionKnowledgeSummary = {
      notes: previous.notes.filter((note) => pins.notes.includes(note.id)),
      plans: previous.plans.filter((plan) => pins.plans.includes(plan.id)),
      memory: previous.memory,
    };
    const entry = { value: next, at: Date.now() };
    summaries.set(key, entry);
    setState(entry);
  }, [input.directory, input.sessionID, key, state]);

  return { summary: state?.value, unavailable, unpin };
}

function trimCache(retainedKey: string): void {
  while (summaries.size >= SUMMARY_CACHE_LIMIT) {
    const oldest = [...summaries].sort((left, right) => left[1].at - right[1].at)[0]?.[0];
    if (!oldest || oldest === retainedKey) break;
    summaries.delete(oldest);
  }
}

function freshCache(key: string): SummaryState {
  const cached = summaries.get(key);
  return cached && Date.now() - cached.at < SUMMARY_TTL_MS ? cached : undefined;
}
