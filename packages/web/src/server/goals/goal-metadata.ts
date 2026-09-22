// SPDX-License-Identifier: Apache-2.0
/**
 * Metadata merge helpers for the goal payload (doc 12 §B.1/§B.5.1).
 *
 * `PATCH /session/{id}` replaces the WHOLE `metadata` object it is handed, so
 * every goal write is a read-modify-merge of the full metadata tree: the
 * `openchamber` namespace may carry unrelated keys, and unrelated namespaces
 * (session-assist payloads, tooling markers) must survive untouched.
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

/** Merge `goal` into `metadata.openchamber.goal`, preserving every other key. */
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

/** The patch body a goal write sends (P-04 `PATCH /session/{id}`). */
export function goalPatchBody(metadata: MetadataRecord): { metadata: MetadataRecord } {
  return { metadata };
}

/**
 * Build the merge-write body for a fresh goal, given the session record the
 * caller just re-read. Returns the patch body and the goal currently stored
 * (the caller's id-guard input).
 */
export function buildGoalWrite(sessionRecord: unknown, next: GoalPayload): {
  body: { metadata: MetadataRecord };
  current: GoalPayload | null;
} {
  const metadata = readMetadata(sessionRecord);
  return {
    body: goalPatchBody(mergeGoalIntoMetadata(metadata, next)),
    current: getSessionGoal(sessionRecord),
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
