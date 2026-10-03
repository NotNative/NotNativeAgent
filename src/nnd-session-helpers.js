// SPDX-License-Identifier: Apache-2.0
import { ContractError, newId, requireExternalId } from './ids.js';
import { validatedNndGoal } from './nnd-goal.js';
import { validNndContextObservation } from './nnd-context-observation.js';
import { directoryFor } from './nnd-session-description.js';

export function catalogRecord(context) {
  return {
    sessionId: context.sessionId, subjectId: context.subjectId, workspaceIds: [...context.workspaceIds],
    ...(context.workspaceBinding ? { workspaceBinding: context.workspaceBinding } : {}),
    title: context.title, directory: directoryFor(context), createdAt: context.createdAt,
    updatedAt: context.updatedAt, archivedAt: context.archivedAt, goalRevision: context.goalRevision,
    reviewMode: context.reviewMode, reviewRevision: context.reviewRevision,
    ...(context.contextUsage ? { contextUsage: context.contextUsage } : {}),
    ...(context.goal ? { goal: context.goal } : {}),
  };
}

export async function restoreNndContexts(records, createContext) {
  for (const record of records) {
    if (!validCatalogRecord(record)) throw new ContractError('nnd_catalog_invalid', 'NND session catalog is invalid');
    await createContext(record.sessionId, { subjectId: record.subjectId, workspaceIds: record.workspaceIds }, {
      title: record.title, directory: record.directory, createdAt: record.createdAt,
      ...(record.workspaceBinding ? { workspaceBinding: record.workspaceBinding } : {}),
      updatedAt: record.updatedAt ?? record.createdAt, archivedAt: record.archivedAt ?? 0,
      goal: record.goal ?? null, goalRevision: record.goalRevision ?? 0, contextUsage: record.contextUsage ?? null,
      reviewMode: record.reviewMode ?? 'default', reviewRevision: record.reviewRevision ?? 0,
    });
  }
}

export function requirePrincipal(principal) {
  if (!principal || typeof principal.subjectId !== 'string' || !principal.subjectId.trim()
    || !Array.isArray(principal.workspaceIds) || principal.workspaceIds.length === 0
    || principal.workspaceIds.some((id) => typeof id !== 'string' || !id.trim())) {
    throw new ContractError('nnd_principal_invalid', 'NND engine context requires an authenticated principal');
  }
}

export function samePrincipal(context, principal) {
  return context.subjectId === principal.subjectId && [...context.workspaceIds].every((id) => principal.workspaceIds.includes(id));
}

export function validCatalogRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  try { requireExternalId(record.sessionId, 'session_id'); requirePrincipal(record); }
  catch { return false; }
  if (record.goal !== undefined) {
    try { validatedNndGoal(record.goal); } catch { return false; }
  }
  if (record.goalRevision !== undefined && (!Number.isSafeInteger(record.goalRevision) || record.goalRevision < 0)) return false;
  if (record.contextUsage !== undefined && !validNndContextObservation(record.contextUsage)) return false;
  if (record.reviewMode !== undefined && !['default', 'auto-review', 'unattended'].includes(record.reviewMode)) return false;
  if (record.reviewRevision !== undefined && (!Number.isSafeInteger(record.reviewRevision) || record.reviewRevision < 0)) return false;
  return typeof record.title === 'string' && record.title.length <= 256 && typeof record.directory === 'string'
    && record.directory.length <= 4096 && Number.isSafeInteger(record.createdAt) && record.createdAt > 0
    && (record.updatedAt === undefined || Number.isSafeInteger(record.updatedAt) && record.updatedAt >= record.createdAt)
    && (record.archivedAt === undefined || Number.isSafeInteger(record.archivedAt) && record.archivedAt >= 0);
}

export async function shutdownAfterFailedCreate(engine, initializationFailure) {
  if (!engine || typeof engine.shutdown !== 'function') return;
  try { await engine.shutdown({ version: '1.0', type: 'shutdown', request_id: newId('nnd_initialize_failed') }); }
  catch (cleanupFailure) {
    const cause = new AggregateError([initializationFailure, cleanupFailure], 'NND engine initialization and cleanup failed.');
    throw new ContractError('nnd_setup_cleanup_failed', 'NND engine cleanup failed. Restart the native process before retrying.', { cause });
  }
}
