// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { nextUpdatedAt } from './nnd-session-description.js';

const STATUSES = new Set(['active', 'paused', 'blocked', 'budgetLimited', 'complete']);
const ID = /^[A-Za-z0-9_-]{4,128}$/u;
const TEXT_LIMITS = Object.freeze({ objective: 5000, note: 280, statusReason: 200,
  evaluationProviderID: 200, evaluationModelID: 200, lastAccountedMessageID: 200 });
const COUNTERS = Object.freeze(['tokensUsed', 'tokensBaseline', 'tokensCommitted', 'turnsUsed',
  'blockedStreak', 'auditFailStreak', 'createdAt', 'updatedAt']);
const FIELDS = new Set(['id', 'status', 'objectiveFile', 'tokenBudget', ...Object.keys(TEXT_LIMITS), ...COUNTERS]);

/** Validate a persisted NND goal without granting arbitrary session metadata writes. */
export function validatedNndGoal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !FIELDS.has(key))
    || typeof value.id !== 'string' || !ID.test(value.id)
    || !STATUSES.has(value.status) || typeof value.objectiveFile !== 'boolean') invalid();
  const result = { id: value.id, status: value.status, objectiveFile: value.objectiveFile };
  for (const [key, limit] of Object.entries(TEXT_LIMITS)) {
    if (typeof value[key] !== 'string' || value[key].length > limit) invalid();
    result[key] = value[key];
  }
  if (!result.objective.trim() && !result.objectiveFile) invalid();
  if (value.tokenBudget !== null && (!Number.isSafeInteger(value.tokenBudget)
    || value.tokenBudget < 1 || value.tokenBudget > 100_000_000)) invalid();
  result.tokenBudget = value.tokenBudget;
  for (const key of COUNTERS) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) invalid();
    result[key] = value[key];
  }
  if (result.createdAt === 0 || result.updatedAt < result.createdAt) invalid();
  return Object.freeze(result);
}

function invalid() { throw new ContractError('nnd_goal_invalid', 'NND goal payload is invalid'); }

/** Candidate-map change and post-persist commit stay under the host's serialized catalog lock. */
export function goalCatalogMutation(context, sessionId, goal, expectedId, expectedRevision) {
  if (expectedId !== null && (typeof expectedId !== 'string' || !ID.test(expectedId))) invalid();
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) invalid();
  let updatedAt;
  return {
    change(contexts) {
      if (context.closing || contexts.get(sessionId) !== context) {
        throw new ContractError('nnd_session_unavailable', 'NND session context is unavailable');
      }
      if ((context.goal?.id ?? null) !== expectedId || context.goalRevision !== expectedRevision) {
        throw new ContractError('nnd_goal_conflict', 'NND goal changed; refresh before writing');
      }
      updatedAt = nextUpdatedAt(context);
      contexts.set(sessionId, { ...context, goal, goalRevision: context.goalRevision + 1, updatedAt });
    },
    commit() { context.goal = goal; context.goalRevision += 1; context.updatedAt = updatedAt; },
  };
}
