// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { ContractError } from './ids.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { readManifestOperation, readManifestSnapshot, transactManifest } from './persistence/manifest-transaction.js';
import { DESKTOP_ID, DESKTOP_OPERATION_ID } from './desktop-request-grammar.js';

/** Build one native settings transaction over a manifest file.
 *
 *  Why: the WebFetch, WebSearch, compatibility, and gateway families share the
 *  same read/preview/save/operation lifecycle, replay-before-fast-fail rule, and
 *  CAS receipt shape. Keeping that lifecycle here means the families can differ
 *  in their document grammar without drifting on the persistence contract.
 *
 *  Domain adapters supply normalize, document, validate, verifySource,
 *  readView, previewView, and payload. */
export function createDesktopSettingsTransaction(config) {
  const { path, installationId, dataId, invalid } = config;
  if (typeof path !== 'string' || !isAbsolute(path) || !DESKTOP_ID.test(installationId ?? '')
    || !DESKTOP_ID.test(dataId ?? '')) throw invalid();
  const context = Object.freeze({
    ...config,
    path,
    invalid,
    identity: { installation_id: installationId, data_id: dataId, scope: 'user' },
    nextAction: config.nextAction
      ?? ((persistence) => persistence === 'saved' ? config.application : 'inspect_native_operation'),
  });
  return Object.freeze({
    read: (principal) => readSettings(context, principal),
    preview: (principal, input) => previewSettings(context, principal, input),
    save: (principal, input) => saveSettings(context, principal, input),
    operation: (principal, operationId) => readSettingsOperation(context, principal, operationId),
  });
}

function authorize(principal, permission, invalid) {
  if (typeof principal?.subjectId !== 'string' || !principal.subjectId.trim() || principal.subjectId.length > 256
    || /[\u0000-\u001f\u007f]/u.test(principal.subjectId) || !Array.isArray(principal.permissions)) throw invalid();
  requireIntegrationPermission(principal, permission);
}

function requireRevision(context, snapshot, request) {
  if (snapshot.revision !== request.expected_revision) {
    throw new ContractError('manifest_revision_conflict', `Reload ${context.conflictLabel} settings.`);
  }
  context.verifySource(snapshot);
}

function operationKey(context, principal, operationId) {
  const subject = createHash('sha256')
    .update(JSON.stringify({ ...context.identity, actor: principal.subjectId })).digest('hex').slice(0, 24);
  return `${context.keyPrefix}${subject}_${operationId}`;
}

function receipt(context, result, operationId) {
  return { ...context.identity, operation_id: operationId, persistence: result.persistence,
    before_revision: result.beforeRevision, persisted_revision: result.persistedRevision,
    application: context.application, replayed: result.replayed, replay_window: result.replayWindow,
    next_action: context.nextAction(result.persistence) };
}

async function readSettings(context, principal) {
  authorize(principal, 'desktop.configuration.read', context.invalid);
  return context.readView(await readManifestSnapshot(context.path), context.identity);
}

async function previewSettings(context, principal, input) {
  authorize(principal, 'desktop.configuration.manage', context.invalid);
  const request = context.normalize(input, context.identity, false);
  const snapshot = await readManifestSnapshot(context.path);
  requireRevision(context, snapshot, request);
  const proposed = context.document(snapshot.rawManifest, request);
  context.validate(proposed);
  return { valid: true,
    ...context.previewView({ ...snapshot, rawManifest: proposed }, context.identity, request, proposed) };
}

async function saveSettings(context, principal, input) {
  authorize(principal, 'desktop.configuration.manage', context.invalid);
  const request = context.normalize(input, context.identity, true);
  // Invariant: a repeated operation keeps its recorded receipt even when the
  // revision has moved on; the replay check precedes the fast-fail.
  const key = operationKey(context, principal, request.operation_id);
  const replayed = await readManifestOperation(context.path, key);
  if (replayed) return receipt(context, replayed, request.operation_id);
  const snapshot = await readManifestSnapshot(context.path);
  requireRevision(context, snapshot, request);
  if (context.preflight) context.preflight(request, snapshot);
  const result = await transactManifest({ path: context.path,
    expectedRevision: request.expected_revision, operationId: key,
    payload: context.payload(request, context.identity, principal),
    transform: (raw, meta) => {
      requireRevision(context, { rawManifest: raw, revision: meta.revision, state: meta.state }, request);
      return context.document(raw, request);
    },
    validate: context.validate,
  });
  return receipt(context, result, request.operation_id);
}

async function readSettingsOperation(context, principal, operationId) {
  authorize(principal, 'desktop.configuration.read', context.invalid);
  if (!DESKTOP_OPERATION_ID.test(operationId ?? '')) throw context.invalid();
  const result = await readManifestOperation(context.path, operationKey(context, principal, operationId));
  return result ? receipt(context, result, operationId) : null;
}
