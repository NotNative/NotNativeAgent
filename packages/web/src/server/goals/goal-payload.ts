// SPDX-License-Identifier: Apache-2.0
/**
 * Goal payload schema (doc 12 §B.1). The payload lives INSIDE the harness
 * session record at `metadata.nnd.goal`, written through NNA's id-guarded
 * goal route. The `nnd` namespace may carry other
 * keys, so every writer merges — never replaces — the namespace.
 *
 * Parsing is deliberately tolerant-but-bounded: an unreadable payload is
 * treated as "no goal" (the loop stays out), while anything readable is
 * clamped into the documented ranges so a hostile/legacy record can never
 * smuggle an unbounded string into an audit prompt.
 */
import { randomBytes } from 'node:crypto';
import {
  GOAL_OBJECTIVE_CHAR_LIMIT,
  GOAL_STATUSES,
  NOTE_CHAR_LIMIT,
  REASON_CHAR_LIMIT,
  TOKEN_BUDGET_MAX,
} from './goal-constants.ts';

export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const GOAL_NAMESPACE = 'nnd';
export const GOAL_METADATA_KEY = 'goal';

/** Objective-file id shape (§B.1): validated BEFORE any filesystem touch. */
export const GOAL_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;

export interface GoalPayload {
  id: string;
  objective: string;
  objectiveFile: boolean;
  /** Immutable random objective generation; absent for legacy files. */
  objectiveFileKey?: string;
  status: GoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  tokensBaseline: number;
  tokensCommitted: number;
  turnsUsed: number;
  blockedStreak: number;
  auditFailStreak: number;
  note: string;
  statusReason: string;
  evaluationProviderID: string;
  evaluationModelID: string;
  lastAccountedMessageID: string;
  createdAt: number;
  updatedAt: number;
}

/** True when the id matches the §B.1 file-safe session id shape. */
export function isGoalFileSessionId(value: string): boolean {
  return GOAL_SESSION_ID_PATTERN.test(value);
}

/** `${ts36}${rand6}` — opaque per-logical-goal id, the stale-write guard key. */
export function newGoalId(now: number = Date.now()): string {
  return `${now.toString(36)}${randomBytes(8).toString('hex').slice(0, 6)}`;
}

function clampText(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function nonNegativeInt(value: unknown): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.floor(raw));
}

function timestamp(value: unknown): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.floor(raw));
}

function flag(value: unknown): boolean {
  return value === true;
}

function parseStatus(value: unknown): GoalStatus | null {
  return (GOAL_STATUSES as readonly string[]).includes(typeof value === 'string' ? value : '')
    ? (value as GoalStatus)
    : null;
}

function parseTokenBudget(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const raw = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : Number.NaN;
  if (!Number.isFinite(raw) || raw < 1 || raw > TOKEN_BUDGET_MAX) return null;
  return raw;
}

/**
 * §B.1 parse. Returns null for anything the loop must treat as "no goal":
 * missing/non-empty `id`, an unknown `status`, or neither an objective nor
 * `objectiveFile`. Numeric fields clamp to `>= 0`; text fields clamp to the
 * documented ceilings.
 */
export function parseGoalPayload(raw: unknown): GoalPayload | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== 'string' || value.id.trim() === '') return null;
  const status = parseStatus(value.status);
  if (!status) return null;
  const objective = clampText(value.objective, GOAL_OBJECTIVE_CHAR_LIMIT);
  const objectiveFile = flag(value.objectiveFile);
  if (objective.trim() === '' && !objectiveFile) return null;
  const now = Date.now();
  return {
    id: value.id.trim(),
    objective,
    objectiveFile,
    ...(typeof value.objectiveFileKey === 'string' && /^[a-f0-9]{64}$/.test(value.objectiveFileKey)
      ? { objectiveFileKey: value.objectiveFileKey } : {}),
    status,
    tokenBudget: parseTokenBudget(value.tokenBudget),
    tokensUsed: nonNegativeInt(value.tokensUsed),
    tokensBaseline: nonNegativeInt(value.tokensBaseline),
    tokensCommitted: nonNegativeInt(value.tokensCommitted),
    turnsUsed: nonNegativeInt(value.turnsUsed),
    blockedStreak: nonNegativeInt(value.blockedStreak),
    auditFailStreak: nonNegativeInt(value.auditFailStreak),
    note: clampText(value.note, NOTE_CHAR_LIMIT),
    statusReason: clampText(value.statusReason, REASON_CHAR_LIMIT),
    evaluationProviderID: clampText(value.evaluationProviderID, 200),
    evaluationModelID: clampText(value.evaluationModelID, 200),
    lastAccountedMessageID: clampText(value.lastAccountedMessageID, 200),
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt) || timestamp(value.createdAt) || now,
  };
}

/** Read the goal out of a session record (any shape) without throwing. */
export function getSessionGoal(sessionRecord: unknown): GoalPayload | null {
  const metadata = (sessionRecord as { metadata?: unknown } | null)?.metadata;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const namespaced = (metadata as Record<string, unknown>)[GOAL_NAMESPACE];
  if (namespaced === null || typeof namespaced !== 'object' || Array.isArray(namespaced)) return null;
  return parseGoalPayload((namespaced as Record<string, unknown>)[GOAL_METADATA_KEY]);
}

/** Shallow clone for mutation-by-copy at write sites. */
export function cloneGoal(goal: GoalPayload): GoalPayload {
  return { ...goal };
}

/** Zeroed counters of a brand-new goal (§B.7 step 3). */
export function freshGoalCounters(): Pick<
  GoalPayload,
  'tokensUsed' | 'tokensBaseline' | 'tokensCommitted' | 'turnsUsed' | 'blockedStreak' | 'auditFailStreak' | 'lastAccountedMessageID'
> {
  return {
    tokensUsed: 0,
    tokensBaseline: 0,
    tokensCommitted: 0,
    turnsUsed: 0,
    blockedStreak: 0,
    auditFailStreak: 0,
    lastAccountedMessageID: '',
  };
}

/** Build the payload `createSessionGoal` patches in (§B.7 step 3). */
export function buildGoalPayload(input: {
  objective: string;
  objectiveFile: boolean;
  objectiveFileKey?: string;
  tokenBudget?: number | null;
  now?: number;
  id?: string;
}): GoalPayload {
  const now = input.now ?? Date.now();
  return {
    id: input.id ?? newGoalId(now),
    objective: input.objective.slice(0, GOAL_OBJECTIVE_CHAR_LIMIT),
    objectiveFile: input.objectiveFile === true,
    ...(input.objectiveFileKey ? { objectiveFileKey: input.objectiveFileKey } : {}),
    status: 'active',
    tokenBudget: parseTokenBudget(input.tokenBudget ?? null),
    note: '',
    statusReason: '',
    evaluationProviderID: '',
    evaluationModelID: '',
    createdAt: now,
    updatedAt: now,
    ...freshGoalCounters(),
  };
}
