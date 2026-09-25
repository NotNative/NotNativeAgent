// SPDX-License-Identifier: Apache-2.0
import { ContractError, newId, requireExternalId } from './ids.js';
import { validatedNndGoal } from './nnd-goal.js';

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
  return typeof record.title === 'string' && record.title.length <= 256 && typeof record.directory === 'string'
    && record.directory.length <= 4096 && Number.isSafeInteger(record.createdAt) && record.createdAt > 0
    && (record.updatedAt === undefined || Number.isSafeInteger(record.updatedAt) && record.updatedAt >= record.createdAt)
    && (record.archivedAt === undefined || Number.isSafeInteger(record.archivedAt) && record.archivedAt >= 0);
}

export async function shutdownAfterFailedCreate(engine) {
  if (!engine || typeof engine.shutdown !== 'function') return;
  try { await engine.shutdown({ version: '1.0', type: 'shutdown', request_id: newId('nnd_initialize_failed') }); }
  catch { /* preserve the initialization failure as the causal error */ }
}
