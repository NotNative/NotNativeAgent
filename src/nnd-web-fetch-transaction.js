// SPDX-License-Identifier: Apache-2.0
/** Native WebFetch trust settings transaction.
 * Why: the census classifies config/web-fetch.json as an authority-grant family (exact
 * credential-free HTTP(S) origins whose private destinations the operator chose to trust),
 * and the webfetch trust/revoke CLI actions now get the same native, authenticated,
 * CAS-receipt path as the 20261005-14 gateway settings family.
 * Invariant: only exact credential-free HTTP(S) origins enter the list; the projection
 * shows the list verbatim (origin grants are public data, not secrets) and the destination
 * policy reloads the file on every fetch, so a saved change classifies under application
 * 'next_fetch', never a restart.
 * Compatibility: this family has no legacy first-party contract; the operation grammar is
 * trust/revoke only. Mechanics mirror the gateway settings transaction of 20261005-14.
 */
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { ContractError } from './ids.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { DEFAULT_WEB_FETCH_CONFIG, MAX_WEB_FETCH_CONFIG_BYTES, normalizeTrustedOrigin, normalizeWebFetchConfig } from './web-fetch-config.js';
import { readManifestSnapshot, readManifestOperation, transactManifest } from './persistence/manifest-transaction.js';

const idPattern = /^[A-Za-z0-9_-]{1,128}$/u;
const operationPattern = /^[A-Za-z0-9_-]{1,64}$/u;
const revisionPattern = /^(?:absent|[a-f0-9]{64})$/u;
const invalid = () => new ContractError('nnd_web_fetch_request_invalid', 'Native WebFetch settings request is invalid.');

function authorize(principal, permission) {
  if (typeof principal?.subjectId !== 'string' || !principal.subjectId.trim() || principal.subjectId.length > 256
    || /[\u0000-\u001f\u007f]/u.test(principal.subjectId) || !Array.isArray(principal.permissions)) throw invalid();
  requireIntegrationPermission(principal, permission);
}

/** Canonicalize the op origin at validate time, exactly like the CLI does, so a preview
 * candidate can never differ from the saved value in normalization. */
function normalizeOperations(operations) {
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 16) throw invalid();
  return operations.map((operation) => {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) throw invalid();
    if (operation.op !== 'trust' && operation.op !== 'revoke') throw invalid();
    if (Object.keys(operation).sort().join(',') !== 'op,origin') throw invalid();
    let origin;
    try { origin = normalizeTrustedOrigin(operation.origin); } catch { throw invalid(); }
    return Object.freeze({ op: operation.op, origin });
  });
}

function normalize(input, identity, save) {
  const keys = ['installation_id', 'data_id', 'scope', 'expected_revision', 'expected_resolution_revision',
    ...(save ? ['operation_id'] : [])];
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !keys.includes(key) && key !== 'operations')
    || Object.entries(identity).some(([key, value]) => input[key] !== value)
    || !revisionPattern.test(input.expected_revision ?? '')
    || input.expected_resolution_revision !== input.expected_revision
    || (save && !operationPattern.test(input.operation_id ?? ''))) throw invalid();
  const operations = input.operations;
  if (operations === undefined) throw invalid();
  return { ...input, operations: normalizeOperations(operations) };
}

/** The CLI's `status`/`trust` on an absent file bootstraps from defaults, so the native
 * transaction mirrors that honestly: reads and trust previews of an absent file show the
 * sticky defaults, while a present-but-invalid file keeps failing closed. */
function sourceForBoot(snapshot) {
  if (snapshot.state === 'missing') return null;
  if (snapshot.rawBytes?.length > MAX_WEB_FETCH_CONFIG_BYTES || !snapshot.rawManifest
    || typeof snapshot.rawManifest !== 'object' || Array.isArray(snapshot.rawManifest)) {
    throw new ContractError('nnd_web_fetch_source_invalid', 'WebFetch settings require explicit repair.');
  }
  try { return normalizeWebFetchConfig(snapshot.rawManifest); }
  catch { throw new ContractError('nnd_web_fetch_source_invalid', 'WebFetch settings require explicit repair.');
  }
}
function source(snapshot) {
  return sourceForBoot(snapshot) ?? DEFAULT_WEB_FETCH_CONFIG;
}

function validateDocument(document) {
  source({ rawManifest: document, state: 'present' });
  if (Buffer.byteLength(`${JSON.stringify(document, null, 2)}\n`) > MAX_WEB_FETCH_CONFIG_BYTES) {
    throw new ContractError('nnd_web_fetch_source_invalid', 'WebFetch settings require explicit repair.');
  }
}

/** Merge applied operations over the raw document, preserving unknown raw fields privately.
 * An absent raw document bootstraps from the published defaults, mirroring the CLI. */
function documentWithOperations(raw, operations) {
  const current = raw === null ? DEFAULT_WEB_FETCH_CONFIG : normalizeWebFetchConfig(raw);
  const candidate = { ...current };
  for (const operation of operations) {
    if (operation.op === 'trust') {
      candidate.trusted_origins = [...new Set([...candidate.trusted_origins, operation.origin])];
    } else {
      candidate.trusted_origins = candidate.trusted_origins.filter((origin) => origin !== operation.origin);
    }
  }
  const prepared = normalizeWebFetchConfig(candidate);
  return { ...raw, ...prepared, updated_at: new Date().toISOString() };
}

function view(snapshot, identity, override) {
  // Invariant: present-but-invalid files stay fail-closed; only preview supplies an
  // explicitly validated override for the proposed content of an absent file.
  const config = override ?? source(snapshot);
  return { ...identity, source_state: snapshot.state === 'missing' ? 'absent' : 'present',
    source_revision: snapshot.revision, resolution_revision: snapshot.revision,
    project_shadowed: false, version: config.version, trusted_origins: [...config.trusted_origins],
    updated_at: config.updated_at ?? null, application: 'next_fetch' };
}

function requireRevision(snapshot, request) {
  if (snapshot.revision !== request.expected_revision) {
    throw new ContractError('manifest_revision_conflict', 'Reload WebFetch settings.');
  }
  source(snapshot);
}

function key(principal, identity, operationId) {
  const subject = createHash('sha256').update(JSON.stringify({ ...identity, actor: principal.subjectId })).digest('hex').slice(0, 24);
  return `nndwft_${subject}_${operationId}`;
}

function receipt(result, identity, operationId) {
  return { ...identity, operation_id: operationId, persistence: result.persistence, before_revision: result.beforeRevision,
    persisted_revision: result.persistedRevision, application: 'next_fetch', replayed: result.replayed,
    replay_window: result.replayWindow,
    next_action: result.persistence === 'saved' ? 'next_fetch' : 'inspect_native_operation' };
}

export function createNndWebFetchSettingsTransaction({ path, installationId, dataId }) {
  if (typeof path !== 'string' || !isAbsolute(path) || !idPattern.test(installationId ?? '') || !idPattern.test(dataId ?? '')) throw invalid();
  const identity = { installation_id: installationId, data_id: dataId, scope: 'user' };
  return Object.freeze({
    async read(principal) {
      authorize(principal, 'nnd.configuration.read');
      return view(await readManifestSnapshot(path), identity);
    },
    async preview(principal, input) {
      authorize(principal, 'nnd.configuration.manage');
      const request = normalize(input, identity, false), snapshot = await readManifestSnapshot(path);
      requireRevision(snapshot, request);
      const proposed = documentWithOperations(snapshot.rawManifest, request.operations);
      validateDocument(proposed);
      return { valid: true, ...view({ ...snapshot, rawManifest: proposed }, identity, normalizeWebFetchConfig(proposed)) };
    },
    async save(principal, input) {
      authorize(principal, 'nnd.configuration.manage');
      const request = normalize(input, identity, true);
      // A repeated operation keeps its recorded receipt even when the revision
      // has moved on; the replay check must precede the fast-fail.
      const operationKey = key(principal, identity, request.operation_id);
      const replayed = await readManifestOperation(path, operationKey);
      if (replayed) return receipt(replayed, identity, request.operation_id);
      // Fast-fail with the honest source code before publishing; the transform
      // rechecks the revision under the lock for atomicity.
      const snapshot = await readManifestSnapshot(path);
      requireRevision(snapshot, request);
      const result = await transactManifest({ path, expectedRevision: request.expected_revision,
        operationId: operationKey,
        payload: { contract: 'nnd-web-fetch-settings-v1', identity, actor: principal.subjectId,
          operations: request.operations.map(({ op, origin }) => ({ op, origin })) },
        transform: (raw, meta) => {
          requireRevision({ rawManifest: raw, revision: meta.revision, state: meta.state }, request);
          return documentWithOperations(raw, request.operations);
        },
        validate: validateDocument,
      });
      return receipt(result, identity, request.operation_id);
    },
    async operation(principal, operationId) {
      authorize(principal, 'nnd.configuration.read');
      if (!operationPattern.test(operationId ?? '')) throw invalid();
      const result = await readManifestOperation(path, key(principal, identity, operationId));
      return result ? receipt(result, identity, operationId) : null;
    },
  });
}
