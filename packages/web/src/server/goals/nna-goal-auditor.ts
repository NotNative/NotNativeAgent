// SPDX-License-Identifier: Apache-2.0
/**
 * Independent goal auditor exchange (doc 12 B.5.5) over NNA's authenticated
 * goal-audit route. NNA binds the call to the final provider route of the
 * audited turn and answers with raw text only; parsing and goal-state
 * mutation stay on this side. The exchange deliberately sends no prompts:
 * verdict candidates persist through the id- and revision-guarded goal CAS,
 * and the loop waits for future turns (or the later dispatch slice).
 */
import { AUDIT_FAIL_LIMIT, BLOCKED_STREAK_LIMIT, GOAL_REASONS } from './goal-constants.ts';
import { parseGoalAuditOutput, type AuditVerdict } from './goal-audit.ts';
import { buildGoalWrite } from './goal-metadata.ts';
import { GOAL_NAMESPACE, cloneGoal, getSessionGoal, type GoalPayload } from './goal-payload.ts';
import { settleGoal } from './goal-state.ts';
import type { GoalSafetyPorts, GoalSafetyTickResult } from './nna-goal-safety-tick.ts';

const AUDIT_ID_LIMIT = 200;
/** NNA answers 4xx/409-class conflicts per error code, not status alone. */
const GOAL_AUDIT_RACE_CODES = new Set(['nnd_goal_audit_conflict', 'nnd_goal_audit_busy']);
/** Accounting-only fields a later tick may legitimately advance. */
const ACCOUNTING_FIELDS = new Set<keyof GoalPayload>([
  'tokensUsed', 'tokensBaseline', 'tokensCommitted', 'lastAccountedMessageID', 'updatedAt',
]);

export interface GoalAuditBody {
  expected_id: string;
  expected_revision: number;
  request_id: string;
  objective: string;
}

/** Raw route outcome; interpretation is a pure, separately tested boundary. */
export interface GoalAuditWire { status: number; body: unknown }

export type GoalAuditCall =
  | { kind: 'verdict'; verdict: AuditVerdict; note: string; providerID: string; modelID: string }
  | { kind: 'unavailable' }
  | { kind: 'race' };

export interface GoalAuditPorts extends GoalSafetyPorts {
  runAudit(sessionId: string, directory: string, body: GoalAuditBody): Promise<GoalAuditWire>;
}

export type GoalAuditExchangeResult =
  | { kind: 'wait'; reason: string }
  | { kind: 'processed'; goal: GoalPayload; verdict: AuditVerdict | null }
  | { kind: 'settled'; goal: GoalPayload; outcome: 'complete' | 'blocked' }
  | { kind: 'dropped'; reason: string };

export interface AuditApplication { goal: GoalPayload; settled: 'complete' | 'blocked' | null }
export interface AuditFailureApplication { goal: GoalPayload; settled: boolean }

type ReadyTick = Extract<GoalSafetyTickResult, { kind: 'ready' }>;

function routeId(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, AUDIT_ID_LIMIT) : '';
}

/**
 * A parsed verdict applies the accounting candidate and the streak bookkeeping.
 * `blocked` streaks accumulate toward the BLOCKED_STREAK_LIMIT settle; every
 * parsed response resets the audit-failure streak and records the attribution.
 * The note survives the prior value only when parsing kept one.
 */
export function applyGoalAuditVerdict(
  goal: GoalPayload, verdict: AuditVerdict, note: string,
  attribution: { providerID: string; modelID: string } | null,
  now: number = Date.now(),
): AuditApplication {
  const next = cloneGoal(goal);
  next.auditFailStreak = 0;
  if (attribution) {
    next.evaluationProviderID = attribution.providerID.slice(0, AUDIT_ID_LIMIT);
    next.evaluationModelID = attribution.modelID.slice(0, AUDIT_ID_LIMIT);
  }
  if (note !== '') next.note = note;
  next.updatedAt = now;
  if (verdict === 'blocked') {
    const streak = goal.blockedStreak + 1;
    if (streak >= BLOCKED_STREAK_LIMIT) {
      const settledGoal = settleGoal(next, 'blocked', note || GOAL_REASONS.blockedPerAudit,
        { note: note || undefined, now });
      return { goal: settledGoal ?? next, settled: 'blocked' };
    }
    next.blockedStreak = streak;
    return { goal: next, settled: null };
  }
  if (verdict === 'complete') {
    const settledGoal = settleGoal(next, 'complete', GOAL_REASONS.verifiedByAudit,
      { note: note || undefined, now });
    return { goal: settledGoal ?? next, settled: 'complete' };
  }
  next.blockedStreak = 0;
  return { goal: next, settled: null };
}

/**
 * An unavailable audit persists ONLY the failure streak: evidence stays
 * unaccounted so the next tick re-audits the same turn, and the second
 * consecutive failure settles blocked (doc 12 T5).
 */
export function applyGoalAuditUnavailable(goal: GoalPayload, now: number = Date.now()): AuditFailureApplication {
  const streak = goal.auditFailStreak + 1;
  if (streak >= AUDIT_FAIL_LIMIT) {
    const settledGoal = settleGoal(goal, 'blocked', GOAL_REASONS.auditUnavailable, { now });
    return { goal: settledGoal ?? goal, settled: true };
  }
  const next = cloneGoal(goal);
  next.auditFailStreak = streak;
  next.updatedAt = now;
  return { goal: next, settled: false };
}

/** A parsed audit response counts as success even when the verdict is `blocked`. */
export function interpretGoalAuditCall(
  wire: GoalAuditWire, objective: string, assistantText: string,
): GoalAuditCall {
  const body = wire.body;
  const shaped = body !== null && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown> : null;
  if (wire.status >= 200 && wire.status < 300 && shaped) {
    if (typeof shaped.text !== 'string') return { kind: 'unavailable' };
    const parsed = parseGoalAuditOutput(shaped.text, objective, assistantText);
    if (!parsed) return { kind: 'unavailable' };
    return { kind: 'verdict', verdict: parsed.verdict, note: parsed.note,
      providerID: routeId(shaped.providerID), modelID: routeId(shaped.modelID) };
  }
  const error = shaped !== null && shaped.error !== null && typeof shaped.error === 'object'
    && !Array.isArray(shaped.error) ? shaped.error as Record<string, unknown> : null;
  return typeof error?.code === 'string' && GOAL_AUDIT_RACE_CODES.has(error.code)
    ? { kind: 'race' } : { kind: 'unavailable' };
}

/** Shallow whole-payload equality; used to skip no-op CAS writes. */
export function sameGoalPayload(a: GoalPayload, b: GoalPayload): boolean {
  const keys = Object.keys(a) as Array<keyof GoalPayload>;
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
}

/** True when a loop-owned field drifted; accounting fields may move freely. */
export function accountingDrift(current: GoalPayload, basis: GoalPayload): boolean {
  for (const key of Object.keys(basis) as Array<keyof GoalPayload>) {
    if (ACCOUNTING_FIELDS.has(key)) continue;
    if (basis[key] !== current[key]) return true;
  }
  return false;
}

/** NNA projects the server-owned revision beside the goal; null when absent. */
export function readGoalRevision(sessionRecord: unknown): number | null {
  const metadata = (sessionRecord as { metadata?: unknown } | null)?.metadata;
  const namespaced = metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)[GOAL_NAMESPACE] : null;
  const revision = namespaced !== null && typeof namespaced === 'object' && !Array.isArray(namespaced)
    ? (namespaced as Record<string, unknown>).goalRevision : null;
  return Number.isSafeInteger(revision) && (revision as number) >= 0 ? revision as number : null;
}

/**
 * Runs after the safety tick produced a `ready` candidate. Every write is a
 * CAS against a fresh re-read, so a user Pause, objective edit, or replacement
 * inside the audit window can only refuse the write, never undo it.
 */
export async function runGoalAuditExchange(
  ports: GoalAuditPorts, ready: ReadyTick, sessionId: string, directory: string,
): Promise<GoalAuditExchangeResult> {
  try {
    if (ready.skipAudit) return await persistAccountingCandidate(ports, ready, sessionId, directory);
    return await auditExchange(ports, ready, sessionId, directory);
  } catch {
    return { kind: 'wait', reason: 'goal audit exchange unavailable' };
  }
}

async function persistAccountingCandidate(
  ports: GoalAuditPorts, ready: ReadyTick, sessionId: string, directory: string,
): Promise<GoalAuditExchangeResult> {
  const session = await ports.readSession(sessionId, directory);
  const current = getSessionGoal(session);
  if (!current || current.id !== ready.goal.id || current.status !== 'active') {
    return { kind: 'dropped', reason: 'goal no longer active' };
  }
  if (accountingDrift(current, ready.goal)) return { kind: 'dropped', reason: 'goal changed since the tick' };
  const written = await writeCandidate(ports, sessionId, directory, session, ready.goal);
  if (written === 'refused') return { kind: 'dropped', reason: 'goal CAS write was refused' };
  return { kind: 'processed', goal: ready.goal, verdict: null };
}

async function auditExchange(
  ports: GoalAuditPorts, ready: ReadyTick, sessionId: string, directory: string,
): Promise<GoalAuditExchangeResult> {
  const first = await ports.readSession(sessionId, directory);
  const basis = getSessionGoal(first);
  if (!basis || basis.id !== ready.goal.id || basis.status !== 'active') {
    return { kind: 'dropped', reason: 'goal no longer active' };
  }
  // A user budget edit, reactivate, or Pause that landed between the tick read
  // and this exchange must refuse the audit verdict write, never be rewritten
  // with the tick's stale payload (doc 12 B.5.1). Accounting-only movement is
  // exempt; the post-audit re-read below covers the audit window itself.
  if (accountingDrift(basis, ready.goal)) {
    return { kind: 'dropped', reason: 'goal changed since the tick' };
  }
  const revision = readGoalRevision(first);
  const requestId = ready.goal.lastAccountedMessageID;
  if (revision === null) return { kind: 'dropped', reason: 'goal revision unavailable' };
  if (requestId === '') return { kind: 'dropped', reason: 'goal cursor unavailable' };
  if (ready.objective.trim() === '') return { kind: 'dropped', reason: 'objective unavailable' };
  const call = await callAuditor(ports, sessionId, directory,
    { expected_id: ready.goal.id, expected_revision: revision, request_id: requestId, objective: ready.objective },
    ready.objective, ready.assistantText);
  const second = await ports.readSession(sessionId, directory);
  const current = getSessionGoal(second);
  if (!current || current.id !== ready.goal.id || current.status !== 'active') {
    return { kind: 'dropped', reason: 'goal no longer active after the audit' };
  }
  if (readGoalRevision(second) !== revision || accountingDrift(current, basis)) {
    return { kind: 'dropped', reason: 'goal changed during the audit' };
  }
  if (call.kind === 'race') return { kind: 'dropped', reason: 'goal audit raced a state change' };
  const now = Date.now();
  if (call.kind === 'unavailable') {
    const application = applyGoalAuditUnavailable(current, now);
    if (sameGoalPayload(current, application.goal)) return { kind: 'processed', goal: current, verdict: null };
    if (await writeCandidate(ports, sessionId, directory, second, application.goal) === 'refused') {
      return { kind: 'dropped', reason: 'goal CAS write was refused' };
    }
    return application.settled
      ? { kind: 'settled', goal: application.goal, outcome: 'blocked' }
      : { kind: 'processed', goal: application.goal, verdict: null };
  }
  const application = applyGoalAuditVerdict(ready.goal, call.verdict, call.note,
    { providerID: call.providerID, modelID: call.modelID }, now);
  if (await writeCandidate(ports, sessionId, directory, second, application.goal) === 'refused') {
    return { kind: 'dropped', reason: 'goal CAS write was refused' };
  }
  return application.settled
    ? { kind: 'settled', goal: application.goal, outcome: application.settled }
    : { kind: 'processed', goal: application.goal, verdict: call.verdict };
}

async function callAuditor(
  ports: GoalAuditPorts, sessionId: string, directory: string, body: GoalAuditBody,
  objective: string, assistantText: string,
): Promise<GoalAuditCall> {
  let wire: GoalAuditWire;
  try { wire = await ports.runAudit(sessionId, directory, body); }
  catch { return { kind: 'unavailable' }; }
  return interpretGoalAuditCall(wire, objective, assistantText);
}

type WriteOutcome = 'written' | 'unchanged' | 'refused';

async function writeCandidate(
  ports: GoalAuditPorts, sessionId: string, directory: string,
  sessionRecord: unknown, next: GoalPayload,
): Promise<WriteOutcome> {
  let body: ReturnType<typeof buildGoalWrite>['body'];
  let current: GoalPayload | null;
  try { ({ body, current } = buildGoalWrite(sessionRecord, next)); }
  catch { return 'refused'; }
  if (current === null || current.id !== next.id) return 'refused';
  if (sameGoalPayload(current, next)) return 'unchanged';
  return await ports.writeGoal(sessionId, directory, body) ? 'written' : 'refused';
}
