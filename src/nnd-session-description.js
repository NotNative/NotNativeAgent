// SPDX-License-Identifier: Apache-2.0
import { isReviewPosture } from './review-posture.js';
import { nndWorkProjection } from './nnd-work-projection.js';
import { nndTurnStateProjection } from './nnd-turn-state.js';

export function describe(context) {
  const governance = governanceProjection(context.engine);
  const configuredModel = configuredModelProjection(context.engine);
  const work = nndWorkProjection(context.engine);
  const turnState = nndTurnStateProjection(context);
  const attention = latestTurnNeedsInput(context.activity) ? { kind: 'needs_input' } : null;
  const nnd = {
    ...(context.contextUsage ? { context: context.contextUsage } : {}),
    ...(governance ? { governance } : {}),
    ...(configuredModel ? { configuredModel } : {}),
    ...(work ? { work } : {}),
    ...(turnState ? { turnState } : {}),
    ...(attention ? { attention } : {}),
  };
  return { id: context.sessionId, slug: context.sessionId, projectID: context.workspaceIds.values().next().value,
    directory: directoryFor(context), title: context.title, version: '1.0',
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...(Object.keys(nnd).length ? { metadata: { nnd } } : {}),
    time: { created: context.createdAt, updated: context.updatedAt,
      ...(context.archivedAt ? { archived: context.archivedAt } : {}) } };
}

/** A completed needs-input turn remains actionable after the transport
 * settles to idle. The latest authored turn record, including the durable
 * Activity snapshot after restart, is the source of this display state. */
export function latestTurnNeedsInput(activity) {
  if (!Array.isArray(activity)) return false;
  const last = [...activity].reverse().find((record) => record?.kind === 'turn');
  return last?.status === 'attention';
}

/** Security: route identity is safe to display; provider profile, endpoint,
 * fallback credentials, and connection settings remain engine-private. */
export function configuredModelProjection(engine) {
  const route = engine?.config?.routes?.primary;
  const validId = (value) => typeof value === 'string' && value.trim().length > 0
    && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
  return validId(route?.providerId) && validId(route?.model)
    ? { providerID: route.providerId, modelID: route.model } : null;
}

/** Security: project only classified governance health, never decision or
 * evidence bodies, authority references, tool arguments, or credentials. */
function governanceProjection(engine) {
  const posture = isReviewPosture(engine?.reviewPosture) ? engine.reviewPosture : null;
  if (typeof engine?.governance?.health !== 'function') {
    return posture ? { reviewPosture: posture } : null;
  }
  let health;
  try { health = engine.governance.health(); }
  catch { return { ...(posture ? { reviewPosture: posture } : {}), recordHealth: 'unavailable' }; }
  const recordHealth = health?.status === 'ready' || health?.status === 'attention' ? health.status : 'unavailable';
  const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return {
    ...(posture ? { reviewPosture: posture } : {}), recordHealth,
    ...(typeof health?.durable === 'boolean' ? { durable: health.durable } : {}),
    ...(nonnegative(health?.attention_evidence) !== null ? { attentionEvidence: health.attention_evidence } : {}),
    ...(nonnegative(health?.unsettled_decisions) !== null ? { unsettledDecisions: health.unsettled_decisions } : {}),
    ...(nonnegative(health?.uncertain_effects) !== null ? { uncertainEffects: health.uncertain_effects } : {}),
  };
}

export function nextUpdatedAt(context) { return Math.max(Date.now(), context.updatedAt + 1); }
export function sessionIdOrder(left, right) { return left.id < right.id ? -1 : left.id > right.id ? 1 : 0; }
export function titleOf(value) { return typeof value === 'string' && value.trim() && value.length <= 256 ? value.trim() : 'New session'; }
export function directoryOf(value) { return typeof value === 'string' && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : ''; }
export function directoryFor(context) { return directoryOf(context.engine.config?.workspaceRoot) || context.directory; }
