// SPDX-License-Identifier: Apache-2.0
/**
 * Recency gates for the work-status panel (§E.9 "computed only while…
 * authoritatively idle"): the panel requires sessionStatusReady + no live
 * status + a completed trailing turn before it commits stats.
 */
import type { DirectoryStore } from '../sync/types.ts';
import { turnStats } from './work-status.ts';
export function panelEligible(state: DirectoryStore, sessionID: string): boolean {
  if (!state.sessionStatusReady) return false;
  const status = state.session_status[sessionID];
  if (status && status.type !== 'idle') return false;
  const messages = state.message[sessionID] ?? [];
  const last = messages.at(-1);
  return Boolean(last && last.role === 'assistant' && last.time.completed !== undefined);
}

export interface PanelStats {
  responseSpeedTokensPerSec: number | null;
  wholeTurnMS: number | null;
  steps: number;
  outputTokens: number | null;
  inputTokens: number | null;
}

/** Committed stats survive the NEXT active turn until a new completion lands. */
export function panelStatsIfNeeded(state: DirectoryStore, sessionID: string, committed: PanelStats | null): PanelStats | null {
  if (committed && !panelEligible(state, sessionID)) return committed; // keep during the next active turn
  if (!panelEligible(state, sessionID)) return null;
  return turnStats(state, sessionID);
}
