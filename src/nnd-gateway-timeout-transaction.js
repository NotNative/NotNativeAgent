// SPDX-License-Identifier: Apache-2.0
/** Private external-store transaction prerequisite. No HTTP route uses this yet. */
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { ContractError } from './ids.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { MAX_GATEWAY_CONFIG_BYTES, normalizeGatewayConfig } from './gateway/config.js';
import { readManifestSnapshot, readManifestOperation, transactManifest } from './persistence/manifest-transaction.js';

const idPattern = /^[A-Za-z0-9_-]{1,128}$/u;
const operationPattern = /^[A-Za-z0-9_-]{1,64}$/u;
const revisionPattern = /^(?:absent|[a-f0-9]{64})$/u;
const invalid = () => new ContractError('nnd_gateway_timeout_request_invalid', 'Native gateway timeout request is invalid.');
function authorize(principal, permission) {
  if (typeof principal?.subjectId !== 'string' || !principal.subjectId.trim() || principal.subjectId.length > 256
    || /[\u0000-\u001f\u007f]/u.test(principal.subjectId) || !Array.isArray(principal.permissions)) throw invalid();
  requireIntegrationPermission(principal, permission);
}
function normalize(input, identity, save) {
  const keys = ['installation_id', 'data_id', 'scope', 'expected_revision', 'expected_resolution_revision', 'polling_timeout_seconds',
    ...(save ? ['operation_id'] : [])];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))
    || Object.entries(identity).some(([key, value]) => input[key] !== value)
    || !revisionPattern.test(input.expected_revision ?? '') || input.expected_resolution_revision !== input.expected_revision
    || !Number.isInteger(input.polling_timeout_seconds) || input.polling_timeout_seconds < 5
    || input.polling_timeout_seconds > 50 || save && !operationPattern.test(input.operation_id ?? '')) throw invalid();
  return input;
}
function source(snapshot) {
  if (snapshot.state === 'missing') throw new ContractError('nnd_gateway_timeout_source_missing', 'Gateway settings must be configured first.');
  if (snapshot.rawBytes?.length > MAX_GATEWAY_CONFIG_BYTES) {
    throw new ContractError('nnd_gateway_timeout_source_invalid', 'Gateway settings require explicit repair.');
  }
  if (!snapshot.rawManifest || typeof snapshot.rawManifest !== 'object' || Array.isArray(snapshot.rawManifest)) {
    throw new ContractError('nnd_gateway_timeout_source_invalid', 'Gateway settings require explicit repair.');
  }
  try { return normalizeGatewayConfig(snapshot.rawManifest); }
  catch { throw new ContractError('nnd_gateway_timeout_source_invalid', 'Gateway settings require explicit repair.'); }
}
function validateDocument(document) {
  source({ rawManifest: document, state: 'present' });
  // The native gateway loader has a smaller bound than the generic manifest store.
  if (Buffer.byteLength(`${JSON.stringify(document, null, 2)}\n`) > MAX_GATEWAY_CONFIG_BYTES) {
    throw new ContractError('nnd_gateway_timeout_source_invalid', 'Gateway settings require explicit repair.');
  }
}
function view(snapshot, identity) {
  const config = source(snapshot);
  return { ...identity, source_revision: snapshot.revision, resolution_revision: snapshot.revision,
    project_shadowed: false, polling_timeout_seconds: config.polling_timeout_seconds, application: 'not_applied' };
}
function requireRevision(snapshot, request) {
  if (snapshot.revision !== request.expected_revision) throw new ContractError('manifest_revision_conflict', 'Reload gateway settings.');
  source(snapshot);
}
function key(principal, identity, operationId) {
  const subject = createHash('sha256').update(JSON.stringify({ ...identity, actor: principal.subjectId })).digest('hex').slice(0, 24);
  return `nndgtw_${subject}_${operationId}`;
}
function receipt(result, identity, operationId) {
  return { ...identity, operation_id: operationId, persistence: result.persistence, before_revision: result.beforeRevision,
    persisted_revision: result.persistedRevision, application: 'not_applied', replayed: result.replayed,
    replay_window: result.replayWindow, next_action: result.persistence === 'saved' ? 'restart_gateway' : 'inspect_native_operation' };
}
export function createNndGatewayTimeoutTransaction({ path, installationId, dataId }) {
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
      const proposed = { ...snapshot.rawManifest, polling_timeout_seconds: request.polling_timeout_seconds };
      validateDocument(proposed);
      return { valid: true, ...view({ ...snapshot, rawManifest: proposed }, identity) };
    },
    async save(principal, input) {
      authorize(principal, 'nnd.configuration.manage');
      const request = normalize(input, identity, true);
      const result = await transactManifest({ path, expectedRevision: request.expected_revision,
        operationId: key(principal, identity, request.operation_id),
        payload: { contract: 'nnd-gateway-timeout-v1', identity, actor: principal.subjectId, request },
        transform: (raw, meta) => {
          requireRevision({ rawManifest: raw, revision: meta.revision, state: meta.state }, request);
          return { ...raw, polling_timeout_seconds: request.polling_timeout_seconds };
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
