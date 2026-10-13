// SPDX-License-Identifier: Apache-2.0
/** Browser goal controls: file-first staging plus NNA's atomic goal CAS. */
import { harnessClient, type HarnessResult } from '../lib/nnd/client.ts';
import { runtimeFetch } from '../lib/runtime-fetch.ts';

export const OBJECTIVE_LIMIT = 5_000;
export type GoalStatus = 'active' | 'paused' | 'blocked' | 'budgetLimited' | 'complete';
export interface SessionGoal {
  id: string; objective: string; objectiveFile: boolean; objectiveFileKey?: string;
  status: GoalStatus; tokenBudget: number | null; tokensUsed: number;
  tokensBaseline: number; tokensCommitted: number; turnsUsed: number;
  blockedStreak: number; auditFailStreak: number; note: string;
  statusReason: string; evaluationProviderID: string; evaluationModelID: string;
  lastAccountedMessageID: string; createdAt: number; updatedAt: number;
}
export interface GoalSnapshot { goal: SessionGoal | null; revision: number }

export interface GoalApi {
  get(id: string): Promise<HarnessResult<{ goal: unknown | null; revision: number }>>;
  evidence(id: string): Promise<HarnessResult<{ session_id: string; latest_request_id: string | null; window_truncated: boolean }>>;
  put(id: string, goal: SessionGoal, expectedId: string | null, revision: number): Promise<HarnessResult<{ goal: unknown | null; revision: number }>>;
  clear(id: string, expectedId: string, revision: number): Promise<HarnessResult<{ goal: unknown | null; revision: number }>>;
  writeFile(id: string, content: string): Promise<string>;
  readFile(id: string, key: string): Promise<string | null>;
  deleteFile(id: string, key: string): Promise<void>;
  abort(id: string): Promise<void>;
}

const fileUrl = (id: string, key?: string): string => `/api/goals/objective/${encodeURIComponent(id)}${key ? `?key=${encodeURIComponent(key)}` : ''}`;

async function objectiveResponse(response: Response): Promise<{ key?: string; content?: string }> {
  const body = await response.json().catch(() => ({})) as { error?: string; key?: string; content?: string };
  if (!response.ok) throw new Error(body.error ?? `Objective request failed (${response.status})`);
  return body;
}

export const browserGoalApi: GoalApi = {
  get: (id) => harnessClient.getSessionGoal(id),
  evidence: (id) => harnessClient.getSessionGoalEvidence(id),
  put: (id, goal, expectedId, revision) => harnessClient.putSessionGoal(id, goal, expectedId, revision),
  clear: (id, expectedId, revision) => harnessClient.clearSessionGoal(id, expectedId, revision),
  async writeFile(id, content) {
    const body = await objectiveResponse(await runtimeFetch(fileUrl(id), {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }),
    }));
    if (!body.key || !/^[a-f0-9]{64}$/.test(body.key)) throw new Error('Objective generation key unavailable');
    return body.key;
  },
  async readFile(id, key) {
    const response = await runtimeFetch(fileUrl(id, key));
    if (response.status === 404) return null;
    return (await objectiveResponse(response)).content ?? null;
  },
  async deleteFile(id, key) {
    await objectiveResponse(await runtimeFetch(fileUrl(id, key), { method: 'DELETE' }));
  },
  async abort(id) { const result = await harnessClient.abortSession(id); if (result.error) throw new Error(result.error); },
};

function requireData<T>(result: HarnessResult<T>): T {
  if (result.error || !result.data) throw new Error(result.error ?? 'Goal response unavailable');
  return result.data;
}

function validGoal(raw: unknown): raw is SessionGoal {
  if (!raw || typeof raw !== 'object') return false;
  const goal = raw as Partial<SessionGoal>;
  return typeof goal.id === 'string' && typeof goal.objective === 'string'
    && typeof goal.objectiveFile === 'boolean'
    && ['active', 'paused', 'blocked', 'budgetLimited', 'complete'].includes(goal.status ?? '');
}

function goalSnapshot(data: { goal: unknown | null; revision: number }): GoalSnapshot {
  if (!Number.isSafeInteger(data.revision) || data.revision < 0) throw new Error('Goal revision unavailable');
  if (data.goal !== null && !validGoal(data.goal)) throw new Error('Goal payload unavailable');
  return { goal: data.goal as SessionGoal | null, revision: data.revision };
}

export async function loadSessionGoal(id: string, api: GoalApi = browserGoalApi): Promise<GoalSnapshot> {
  return goalSnapshot(requireData(await api.get(id)));
}

export async function effectiveObjective(id: string, goal: SessionGoal, api: GoalApi = browserGoalApi): Promise<string> {
  if (!goal.objectiveFile) return goal.objective;
  try { return await api.readFile(id, goal.objectiveFileKey ?? '') ?? goal.objective; }
  catch { return goal.objective; }
}

function newGoal(objective: string, tokenBudget: number | null, cursor: string, now = Date.now()): SessionGoal {
  return {
    id: crypto.randomUUID(), objective, objectiveFile: false, status: 'active', tokenBudget,
    tokensUsed: 0, tokensBaseline: 0, tokensCommitted: 0, turnsUsed: 0,
    blockedStreak: 0, auditFailStreak: 0, note: '', statusReason: '',
    evaluationProviderID: '', evaluationModelID: '', lastAccountedMessageID: cursor,
    createdAt: now, updatedAt: now,
  };
}

/** Create/edit: stage a unique file, CAS metadata, then retire the old key. */
export async function saveSessionGoal(id: string, text: string, budget: number | null, api: GoalApi = browserGoalApi): Promise<GoalSnapshot> {
  const objective = text.trim().slice(0, OBJECTIVE_LIMIT);
  if (!objective) throw new Error('Goal objective is required');
  if (budget !== null && (!Number.isSafeInteger(budget) || budget < 1 || budget > 100_000_000)) throw new Error('Goal budget is invalid');
  const current = await loadSessionGoal(id, api);
  if (current.goal?.status === 'complete') throw new Error('Clear the completed goal before arming another');
  const evidence = current.goal ? null : requireData(await api.evidence(id));
  if (evidence && evidence.session_id !== id) throw new Error('Goal turn evidence belongs to another session');
  if (evidence?.window_truncated && !evidence.latest_request_id) {
    throw new Error('Goal turn history is incomplete; start a fresh session before arming a token-budgeted goal');
  }
  const cursor = evidence?.latest_request_id ?? '';
  let stagedKey = '';
  try { stagedKey = await api.writeFile(id, objective); } catch { /* inline fallback */ }
  const now = Date.now();
  const goal: SessionGoal = current.goal ? {
    ...current.goal, objective, objectiveFile: Boolean(stagedKey),
    ...(stagedKey ? { objectiveFileKey: stagedKey } : { objectiveFileKey: undefined }),
    tokenBudget: budget, status: 'active', statusReason: 'resumed', turnsUsed: 0,
    blockedStreak: 0, auditFailStreak: 0, updatedAt: now,
  } : {
    ...newGoal(objective, budget, cursor, now), objectiveFile: Boolean(stagedKey),
    ...(stagedKey ? { objectiveFileKey: stagedKey } : {}),
  };
  const result = await api.put(id, goal, current.goal?.id ?? null, current.revision);
  if (result.error) {
    if (stagedKey) await api.deleteFile(id, stagedKey).catch(() => undefined);
    throw new Error(result.error);
  }
  if (current.goal?.objectiveFile) await api.deleteFile(id, current.goal.objectiveFileKey ?? '').catch(() => undefined);
  return goalSnapshot(requireData(result));
}

export async function changeGoalStatus(id: string, action: 'pause' | 'resume' | 'complete', api: GoalApi = browserGoalApi): Promise<GoalSnapshot> {
  const current = await loadSessionGoal(id, api);
  const goal = current.goal;
  if (!goal) throw new Error('Goal no longer exists');
  if (action === 'pause' && goal.status !== 'active') throw new Error('Only an active goal can be paused');
  if (action === 'resume' && !['paused', 'blocked', 'budgetLimited'].includes(goal.status)) throw new Error('Goal cannot be resumed');
  if (action === 'complete' && goal.status === 'complete') return current;
  const next: SessionGoal = { ...goal, updatedAt: Date.now() };
  if (action === 'pause') { next.status = 'paused'; next.statusReason = 'paused by user'; }
  if (action === 'resume') {
    next.status = 'active'; next.statusReason = 'resumed'; next.turnsUsed = 0;
    next.blockedStreak = 0; next.auditFailStreak = 0;
  }
  if (action === 'complete') {
    next.status = 'complete'; next.statusReason = 'marked by user';
    next.blockedStreak = 0; next.auditFailStreak = 0;
  }
  const result = await api.put(id, next, goal.id, current.revision);
  if (result.error) throw new Error(result.error);
  const committed = goalSnapshot(requireData(result));
  if (action === 'pause' || action === 'complete') {
    try { await api.abort(id); }
    catch { throw new Error(`Goal ${action === 'pause' ? 'paused' : 'completed'}, but stopping the current turn failed. Check session status and stop it manually.`); }
  }
  return committed;
}

export async function clearSessionGoal(id: string, api: GoalApi = browserGoalApi): Promise<GoalSnapshot> {
  const current = await loadSessionGoal(id, api);
  if (!current.goal) return current;
  const result = await api.clear(id, current.goal.id, current.revision);
  if (result.error) throw new Error(result.error);
  const committed = goalSnapshot(requireData(result));
  let stopFailed = false;
  if (current.goal.status === 'active') {
    try { await api.abort(id); } catch { stopFailed = true; }
  }
  if (current.goal.objectiveFile) await api.deleteFile(id, current.goal.objectiveFileKey ?? '').catch(() => undefined);
  if (stopFailed) throw new Error('Goal cleared, but stopping the current turn failed. Check session status and stop it manually.');
  return committed;
}
