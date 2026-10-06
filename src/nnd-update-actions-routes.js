// SPDX-License-Identifier: Apache-2.0
/** Native update action routes over /v1/nnd/configuration/update/actions.
 * Why: the two census operator_action rows (check/install) describe the update
 * CLI whose authority lives in src/update-service.js — this surface reuses
 * checkForUpdate VERBATIM, so the version comparison, the state-file refresh,
 * and the honest unavailability receipt stay exactly as shipped to the CLI.
 * check is an operator action on the update-state store: it forces a live
 * repository probe (the -4 slice's update-state observation is the cached
 * read-only view and stays untouched) and records the result. install is
 * refused honestly: it downloads the archive and runs the product's own
 * installer as a child that inherits the caller's console and replaces the
 * running implementation; an HTTP handler cannot host that surface (the CLI
 * `nna update` remains its authority), so the operator surface refuses with
 * nnd_update_install_unsupported instead of half-doing a system mutation.
 * Invariants: receipts pin the availability grammar exactly (format-free
 * bounded strings, booleans for cached/available); the check verdict is a
 * plain record, never a value-bearing error; projection drift fails closed
 * (nnd_update_projection_invalid, 500).
 */
import { VERSION } from './product.js';
import { ContractError } from './ids.js';
import { checkForUpdate } from './update-service.js';
import { send } from './secret-broker-server.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { randomUUID } from 'node:crypto';

const BASE = '/v1/nnd/configuration/update/actions';
const MANAGE = 'nnd.update.manage';
const REQUEST_BYTES = 4096;
const RESPONSE_BYTES = 65_536;
const BOUNDED = /^[A-Za-z0-9 .:+_-]{1,256}$/u;
const UPDATE_VERSION = /^(?:v)?\d{8}-\d{1,6}$/u;
const invalid = () => new ContractError('nnd_update_action_invalid', 'Native update action is invalid.');
const projection = () => new ContractError('nnd_update_projection_invalid', 'Update action refused a drifted projection.');

export async function dispatchNndUpdateActionsRequest(request, response, context) {
  const path = context.url.pathname;
  if (path !== `${BASE}/check` && path !== `${BASE}/install`) return false;
  const service = context.nndUpdateActionsService;
  if (!service || typeof service.check !== 'function') {
    throw new ContractError('nnd_configuration_unavailable', 'Native update actions are unavailable.');
  }
  requireIntegrationPermission(context.principal, MANAGE);
  if (request.method !== 'POST') return send(response, 405, { error: 'method_not_allowed' });
  if (context.url.search) throw invalid();
  if (path === `${BASE}/install`) {
    // The installer inherits the owning console and replaces the running
    // implementation; the CLI `nna update` is its authority.
    await readEmptyBody(request);
    throw new ContractError('nnd_update_install_unsupported',
      'the product installer runs through the local CLI, not this operator surface');
  }
  await readEmptyBody(request);
  return sendBounded(response, projectAction(await service.check()));
}

export function createNndUpdateActionsService({ statePath, fetchImpl, currentVersion = VERSION,
  installationId, dataId }) {
  if (typeof statePath !== 'string' || !statePath || !UPDATE_VERSION.test(currentVersion)) throw invalid();
  return Object.freeze({
    async check(overrides = {}) {
      const value = await checkForUpdate({ statePath, currentVersion,
        fetchImpl: overrides.fetchImpl ?? fetchImpl, timeoutMs: overrides.timeoutMs ?? 10_000, force: true });
      return { installationId, dataId, operationId: randomUUID(), value };
    },
  });
}

export function projectAction(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || !/^[0-9a-f-]{36}$/u.test(record.operationId ?? '')) throw projection();
  const keys = new Set(Object.keys(record));
  if (keys.size !== 4 || !['dataId', 'installationId', 'operationId', 'value'].every(key => keys.has(key))) {
    throw projection();
  }
  const value = record.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw projection();
  const availability = new Set(Object.keys(value));
  if (availability.size !== 10
    || !['status', 'checked_at', 'cached', 'current_version', 'latest_version', 'latest_ref',
      'latest_tag', 'latest_sha', 'available', 'error_code'].every(key => availability.has(key))) {
    throw projection();
  }
  if (value.status !== 'ready' && value.status !== 'unavailable') throw projection();
  if (Number.isNaN(Date.parse(value.checked_at)) || value.cached !== false
    || (value.available !== true && value.available !== false)) throw projection();
  for (const key of ['current_version', 'latest_version', 'latest_ref', 'latest_tag', 'latest_sha', 'error_code']) {
    if (value[key] !== null && (typeof value[key] !== 'string' || value[key].length > 128
      || value[key].length < 1 || !BOUNDED.test(value[key]))) throw projection();
  }
  if (value.status === 'ready'
    && (value.latest_version === null || value.latest_sha === null
      || !/^[a-f0-9]{40}$/u.test(value.latest_sha) || value.error_code !== null)) throw projection();
  if (value.status === 'unavailable' && value.error_code === null) throw projection();
  return { schema_version: '1.0', installation_id: record.installationId, data_id: record.dataId,
    scope: 'user', action: 'check', application: 'update_check_recorded',
    operation_id: record.operationId, availability: { ...value } };
}

function sendBounded(response, value) {
  if (Buffer.byteLength(JSON.stringify(value)) > RESPONSE_BYTES) throw projection();
  return send(response, 200, value);
}

/** Input-less verbs accept only an empty (or empty-object) body so stray state
 * can never ride an operator action. */
async function readEmptyBody(request) {
  let size = 0; const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > REQUEST_BYTES) throw new ContractError('request_too_large', 'update action request exceeds its size bound');
    chunks.push(chunk);
  }
  if (size === 0) return;
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw invalid(); }
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    && Object.keys(parsed).length === 0) return;
  throw invalid();
}
