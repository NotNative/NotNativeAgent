// SPDX-License-Identifier: Apache-2.0
/**
 * Metadata merge helpers for the goal payload (doc 12 §B.1/§B.5.1).
 *
 * Pure metadata merge helpers. The NNA-backed route accepts only goal writes,
 * with an atomic expected-id guard; generic metadata replacement is forbidden.
 * The `nnd` namespace may carry unrelated NNA projections.
 */
import {
  GOAL_METADATA_KEY,
  GOAL_NAMESPACE,
  getSessionGoal,
  type GoalPayload,
} from './goal-payload.ts';

export type MetadataRecord = Record<string, unknown>;

/** Read the metadata tree as a plain object ('' shape tolerated). */
export function readMetadata(sessionRecord: unknown): MetadataRecord {
  const metadata = (sessionRecord as { metadata?: unknown } | null)?.metadata;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  return { ...(metadata as MetadataRecord) };
}

function readNamespace(metadata: MetadataRecord): MetadataRecord {
  const namespaced = metadata[GOAL_NAMESPACE];
  if (namespaced === null || typeof namespaced !== 'object' || Array.isArray(namespaced)) return {};
  return { ...(namespaced as MetadataRecord) };
}

/** Merge `goal` into `metadata.nnd.goal`, preserving every other key. */
export function mergeGoalIntoMetadata(metadata: MetadataRecord, goal: GoalPayload): MetadataRecord {
  const namespaced = readNamespace(metadata);
  return {
    ...metadata,
    [GOAL_NAMESPACE]: { ...namespaced, [GOAL_METADATA_KEY]: goal },
  };
}

/** Delete only the goal key; the namespace (and its other keys) survives. */
export function removeGoalFromMetadata(metadata: MetadataRecord): MetadataRecord {
  const namespaced = readNamespace(metadata);
  const rest: MetadataRecord = { ...namespaced };
  delete rest[GOAL_METADATA_KEY];
  const next: MetadataRecord = { ...metadata };
  if (Object.keys(rest).length === 0) delete next[GOAL_NAMESPACE];
  else next[GOAL_NAMESPACE] = rest;
  return next;
}

/**
 * Build NNA's dedicated goal write. The server checks expected_id atomically
 * against its durable session catalog, so a stale client cannot overwrite a
 * replaced or cleared goal between its read and write.
 */
export function buildGoalWrite(sessionRecord: unknown, next: GoalPayload): {
  body: { goal: GoalPayload; expected_id: string | null; expected_revision: number };
  current: GoalPayload | null;
} {
  const current = getSessionGoal(sessionRecord);
  const revision = (readMetadata(sessionRecord)[GOAL_NAMESPACE] as Record<string, unknown> | undefined)?.goalRevision;
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) {
    throw new Error('NNA session goal revision is unavailable; refresh before writing');
  }
  return {
    body: { goal: next, expected_id: current?.id ?? null, expected_revision: revision as number },
    current,
  };
}

/**
 * §B.5.1 stale-write guard: re-read, parse, compare ids. Returns null when the
 * goal the caller planned to update is gone or was replaced — every runtime
 * write passes through here.
 */
export function idGuardMatches(sessionRecord: unknown, expectedGoalId: string): boolean {
  const current = getSessionGoal(sessionRecord);
  return current !== null && current.id === expectedGoalId;
}
