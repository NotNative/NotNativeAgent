// SPDX-License-Identifier: Apache-2.0
/** Native gateway settings transaction for the whole operator family.
 * Why: the polling-timeout contract (20261003-25) provided the shell; the native gateway
 * settings contract now covers enabled, token_env, workspace_root, polling_timeout_seconds,
 * the redacted Telegram token (dedicated replace/clear operations only), and the authorized
 * user-id allowlist (authority operations only, never an ordinary presentation preference).
 * Invariant: normal reads project token presence and source, never token values.
 * Compatibility: the first-party flat request (polling_timeout_seconds) keeps working and is
 * recorded by the settings census as a compatibility alias of the operation grammar.
 */
import { isAbsolute } from 'node:path';
import { ContractError } from './ids.js';
import { MAX_GATEWAY_CONFIG_BYTES, DEFAULT_GATEWAY_CONFIG, normalizeGatewayConfig, normalizeUserId } from './gateway/config.js';
import { createDesktopSettingsTransaction } from './desktop-settings-transaction.js';
import { DESKTOP_REVISION } from './desktop-request-grammar.js';
import { DESKTOP_OPERATION_ID } from './desktop-request-grammar.js';

const operationPattern = DESKTOP_OPERATION_ID;
const revisionPattern = DESKTOP_REVISION;
const invalid = () => new ContractError('desktop_gateway_timeout_request_invalid', 'Native gateway settings request is invalid.');

const SET_FIELDS = Object.freeze({
  enabled: (value) => typeof value === 'boolean',
  token_env: (value) => typeof value === 'string' && /^[A-Z_][A-Z0-9_]{0,127}$/u.test(value),
  workspace_root: (value) => value === null || (typeof value === 'string' && value.trim() !== ''
    && value.length <= 4096 && isAbsolute(value)),
  polling_timeout_seconds: (value) => Number.isInteger(value) && value >= 5 && value <= 50,
});
const RESET_DEFAULTS = Object.freeze(Object.fromEntries(['enabled', 'token_env', 'workspace_root', 'polling_timeout_seconds']
  .map((field) => [field, DEFAULT_GATEWAY_CONFIG[field]])));

function normalizeOperations(operations) {
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 16) throw invalid();
  return operations.map((operation) => {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) throw invalid();
    switch (operation.op) {
      case 'set': {
        const keys = Object.keys(operation).sort().join(',');
        // Invariant: the field lookup must not run inherited methods. A hostile
        // field name must reject as a grammar error, not reach object internals.
        const validator = Object.hasOwn(SET_FIELDS, operation.field) ? SET_FIELDS[operation.field] : null;
        if (keys !== 'field,op,value' || !validator || !validator(operation.value)) throw invalid();
        if (operation.value === null && operation.field !== 'workspace_root') throw invalid();
        return Object.freeze({ op: 'set', field: operation.field, value: operation.value });
      }
      case 'reset': {
        if (Object.keys(operation).sort().join(',') !== 'field,op' || !Object.hasOwn(RESET_DEFAULTS, operation.field)) throw invalid();
        return Object.freeze({ op: 'reset', field: operation.field });
      }
      case 'set_token': {
        const value = operation.token;
        if (Object.keys(operation).sort().join(',') !== 'op,token' || typeof value !== 'string'
          || value.length < 20 || value.length > 512 || /[\r\n]/u.test(value)) throw invalid();
        return Object.freeze({ op: 'set_token', token: value });
      }
      case 'clear_token':
        if (Object.keys(operation).join(',') !== 'op') throw invalid();
        return Object.freeze({ op: 'clear_token' });
      case 'authorize':
      case 'revoke': {
        if (Object.keys(operation).sort().join(',') !== 'op,user_id') throw invalid();
        let userId;
        try { userId = normalizeUserId(operation.user_id); } catch { throw invalid(); }
        return Object.freeze({ op: operation.op, user_id: userId });
      }
      default: throw invalid();
    }
  });
}

function normalize(input, identity, save) {
  const keys = ['installation_id', 'data_id', 'scope', 'expected_revision', 'expected_resolution_revision',
    ...(save ? ['operation_id'] : [])];
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !keys.includes(key) && key !== 'operations' && key !== 'polling_timeout_seconds')
    || Object.entries(identity).some(([key, value]) => input[key] !== value)
    || !revisionPattern.test(input.expected_revision ?? '')
    || input.expected_resolution_revision !== input.expected_revision
    || (save && !operationPattern.test(input.operation_id ?? ''))) throw invalid();
  if (input.operations !== undefined && input.polling_timeout_seconds !== undefined) throw invalid();
  let operations;
  if (input.operations !== undefined) operations = normalizeOperations(input.operations);
  else if (Number.isInteger(input.polling_timeout_seconds) && input.polling_timeout_seconds >= 5
    && input.polling_timeout_seconds <= 50) {
    operations = normalizeOperations([{ op: 'set', field: 'polling_timeout_seconds', value: input.polling_timeout_seconds }]);
  } else throw invalid();
  return { ...input, operations };
}

function source(snapshot) {
  if (snapshot.state === 'missing') throw new ContractError('desktop_gateway_timeout_source_missing', 'Gateway settings must be configured first.');
  if (snapshot.rawBytes?.length > MAX_GATEWAY_CONFIG_BYTES) {
    throw new ContractError('desktop_gateway_timeout_source_invalid', 'Gateway settings require explicit repair.');
  }
  if (!snapshot.rawManifest || typeof snapshot.rawManifest !== 'object' || Array.isArray(snapshot.rawManifest)) {
    throw new ContractError('desktop_gateway_timeout_source_invalid', 'Gateway settings require explicit repair.');
  }
  try { return normalizeGatewayConfig(snapshot.rawManifest); }
  catch { throw new ContractError('desktop_gateway_timeout_source_invalid', 'Gateway settings require explicit repair.'); }
}

function validateDocument(document) {
  source({ rawManifest: document, state: 'present' });
  // The native gateway loader has a smaller bound than the generic manifest store.
  if (Buffer.byteLength(`${JSON.stringify(document, null, 2)}\n`) > MAX_GATEWAY_CONFIG_BYTES) {
    throw new ContractError('desktop_gateway_timeout_source_invalid', 'Gateway settings require explicit repair.');
  }
}

/** Merge applied operations over the raw document, preserving unknown raw fields privately. */
function documentWithOperations(raw, operations) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ContractError('desktop_gateway_timeout_source_invalid', 'Gateway settings require explicit repair.');
  }
  const current = normalizeGatewayConfig(raw);
  const candidate = { ...current };
  for (const operation of operations) {
    switch (operation.op) {
      case 'set': candidate[operation.field] = operation.value; break;
      case 'reset': candidate[operation.field] = RESET_DEFAULTS[operation.field]; break;
      case 'set_token': candidate.token = operation.token; break;
      case 'clear_token': candidate.token = null; break;
      case 'authorize': candidate.authorized_user_ids = [...new Set([...candidate.authorized_user_ids, operation.user_id])].sort(); break;
      case 'revoke': candidate.authorized_user_ids = candidate.authorized_user_ids.filter(id => id !== operation.user_id); break;
      default: throw invalid();
    }
  }
  const prepared = normalizeGatewayConfig(candidate);
  return { ...raw, ...prepared, updated_at: new Date().toISOString() };
}

function view(snapshot, identity) {
  const config = source(snapshot);
  return { ...identity, source_revision: snapshot.revision, resolution_revision: snapshot.revision,
    project_shadowed: false, version: config.version, enabled: config.enabled,
    token_present: config.token !== null, token_env: config.token_env,
    authorized_user_ids: [...config.authorized_user_ids], workspace_root: config.workspace_root,
    polling_timeout_seconds: config.polling_timeout_seconds,
    updated_at: config.updated_at ?? null, application: 'not_applied' };
}

export function createDesktopGatewaySettingsTransaction({ path, installationId, dataId }) {
  return createDesktopSettingsTransaction({
    path, installationId, dataId, invalid,
    keyPrefix: 'nndgtw_', application: 'not_applied', conflictLabel: 'gateway',
    nextAction: (persistence) => persistence === 'saved' ? 'restart_gateway' : 'inspect_native_operation',
    normalize,
    document: (raw, request) => documentWithOperations(raw, request.operations),
    validate: validateDocument,
    verifySource: source,
    readView: (snapshot, identity) => view(snapshot, identity),
    previewView: (snapshot, identity) => view(snapshot, identity),
    payload: (request, identity, principal) => ({ contract: 'desktop-gateway-settings-v1', identity,
      actor: principal.subjectId,
      operations: request.operations.map((operation) =>
        operation.op === 'set' ? { op: 'set', field: operation.field }
          : operation.op === 'authorize' || operation.op === 'revoke'
            ? { op: operation.op, user_id: operation.user_id } : { op: operation.op }) }),
  });
}

/** Compatibility alias: the polling-timeout slice named the service after its first field. */
export const createDesktopGatewayTimeoutTransaction = createDesktopGatewaySettingsTransaction;
