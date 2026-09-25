// SPDX-License-Identifier: Apache-2.0
/** Pre-audit NNA goal tick: authoritative quiescence, evidence, CAS hard stops. */
import { MESSAGE_FETCH_LIMIT } from './goal-constants.ts';
import { buildGoalWrite } from './goal-metadata.ts';
import { getSessionGoal, type GoalPayload } from './goal-payload.ts';
import { decideNnaGoalEvidence } from './nna-goal-evidence.ts';

export interface GoalSafetyPorts {
  listSessions(): Promise<unknown>;
  readSession(sessionId: string, directory: string): Promise<unknown>;
  readObjective(goal: GoalPayload, sessionId: string): Promise<string | null>;
  readStatus(directory: string): Promise<unknown>;
  readChildren(sessionId: string, directory: string): Promise<unknown>;
  readMessages(sessionId: string, directory: string, limit: number): Promise<unknown>;
  readEvidence(sessionId: string, directory: string): Promise<unknown>;
  writeGoal(sessionId: string, directory: string, body: ReturnType<typeof buildGoalWrite>['body']): Promise<boolean>;
}

export type GoalSafetyTickResult =
  | { kind: 'wait'; reason: string }
  | { kind: 'conflict' }
  | { kind: 'settled'; goal: GoalPayload }
  | { kind: 'ready'; goal: GoalPayload; objective: string; assistantText: string; tailId: string; skipAudit: boolean };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function sessionRoot(value: unknown): boolean {
  const item = record(value);
  return item !== null && typeof item.id === 'string' && !item.parentID;
}

function childBusy(children: unknown, status: Record<string, unknown>): boolean | null {
  if (!Array.isArray(children)) return null;
  for (const child of children) {
    const id = record(child)?.id;
    if (typeof id !== 'string' || id === '') return null;
    if (Object.hasOwn(status, id)) return true;
  }
  return false;
}

function assistantTail(messages: unknown): { id: string; text: string } | null {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const last = record(messages.at(-1));
  const lastInfo = record(last?.info);
  if (lastInfo?.role !== 'assistant' || typeof lastInfo.id !== 'string'
    || !Number.isFinite(record(lastInfo.time)?.completed)) return null;
  const parts = last?.parts;
  if (!Array.isArray(parts)) return null;
  const text = parts.flatMap((part) => {
    const item = record(part);
    return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : [];
  }).join('\n');
  return { id: lastInfo.id, text };
}

/** A cancelled NNA turn may journal only its submitted user message. */
function resumedUserTail(messages: unknown, requestId: string): string | null {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const info = record(record(messages.at(-1))?.info);
  return info?.role === 'user' && info.id === requestId ? requestId : null;
}

async function settleWithCas(
  ports: GoalSafetyPorts, sessionId: string, directory: string,
  initial: unknown, next: GoalPayload,
): Promise<GoalSafetyTickResult> {
  const expected = buildGoalWrite(initial, next).body;
  const current = await ports.readSession(sessionId, directory);
  if (!sessionRoot(current)) return { kind: 'conflict' };
  const fresh = getSessionGoal(current);
  if (fresh?.id !== next.id) return { kind: 'conflict' };
  const candidate = buildGoalWrite(current, next).body;
  if (candidate.expected_revision !== expected.expected_revision) return { kind: 'conflict' };
  return await ports.writeGoal(sessionId, directory, expected)
    ? { kind: 'settled', goal: next } : { kind: 'conflict' };
}

/** No continuation is sent here. `ready` must enter the later audit/dispatch path. */
export async function runNnaGoalSafetyTick(
  ports: GoalSafetyPorts, sessionId: string, directory: string,
): Promise<GoalSafetyTickResult> {
  try {
    const session = await ports.readSession(sessionId, directory);
    if (!sessionRoot(session) || record(session)?.id !== sessionId) return { kind: 'wait', reason: 'session unavailable or child' };
    const goal = getSessionGoal(session);
    if (goal?.status !== 'active') return { kind: 'wait', reason: 'goal not active' };
    const status = record(await ports.readStatus(directory));
    if (!status) return { kind: 'wait', reason: 'status unavailable' };
    if (Object.hasOwn(status, sessionId)) return { kind: 'wait', reason: 'session busy' };
    const childrenBusy = childBusy(await ports.readChildren(sessionId, directory), status);
    if (childrenBusy !== false) return { kind: 'wait', reason: childrenBusy ? 'child busy' : 'children unavailable' };
    const evidence = await ports.readEvidence(sessionId, directory);
    const decision = decideNnaGoalEvidence(goal, sessionId, evidence);
    if (decision.kind === 'settle') return settleWithCas(ports, sessionId, directory, session, decision.goal);
    if (decision.kind === 'wait') return { kind: 'wait', reason: 'no new completed turn' };
    const objective = (await ports.readObjective(goal, sessionId))?.trim();
    if (!objective) return { kind: 'wait', reason: 'objective unavailable' };
    const messages = await ports.readMessages(sessionId, directory, MESSAGE_FETCH_LIMIT);
    const tail = assistantTail(messages);
    if (!tail && decision.kind === 'continue') {
      const id = resumedUserTail(messages, decision.goal.lastAccountedMessageID);
      if (id) return { kind: 'ready', goal: decision.goal, objective, assistantText: '', tailId: id, skipAudit: true };
    }
    if (!tail) return { kind: 'wait', reason: 'assistant tail incomplete' };
    return { kind: 'ready', goal: decision.goal, objective, assistantText: tail.text,
      tailId: tail.id, skipAudit: decision.kind === 'continue' };
  } catch {
    return { kind: 'wait', reason: 'goal tick dependency unavailable' };
  }
}
