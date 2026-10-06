// SPDX-License-Identifier: Apache-2.0
/** Native update-state observation (read-only).
 * Why: the census classifies the eight update_state entries as generated_state under
 * NNA's update worker; the settings GUI must show the recorded check result exactly as
 * the store holds it instead of repeating a private web request from the renderer.
 * Invariant: read-only — the update worker (and its install path) is the only writer;
 * the surface loads through the store's own readUpdateState validator, so any content
 * the validator refuses (absent, corrupt, or foreign-shaped) projects as the sticky
 * state 'absent' — "no VALID recorded check" — never a guessed shape. A validator-
 * accepted record projects as stored (store grammar parity: optional v-prefix and
 * long sequence numbers on latest_version, any finite parsed timestamp, length-bounded
 * brief strings). The projection carries exactly the eight census-classified fields;
 * installed_at stays in the store but unprojected until the census classifies it.
 * Unknown fields are dropped, both identity keys stay fixed to the service identity.
 */
import { ContractError } from './ids.js';
import { send } from './secret-broker-server.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { readUpdateState } from './update-service.js';

const BASE = '/v1/nnd/configuration/update-state';
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
// Store-grammar parity (update-service.js readUpdateState): the store accepts an
// optional v prefix, a long sequence number, any finite parsed timestamp, and any
// string of at most 256 characters for ref/tag/error_code. Drift beyond that
// (status/format/sha lies) stays fail-closed.
const VERSION = /^(?:v)?\d{8}-\d{1,15}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const invalid = () => new ContractError('nnd_update_state_request_invalid',
  'Native update state request is invalid.');

// Every field is worker-generated state; the update worker and its install path are the
// only writers, so the surface offers nothing editable.
const FIELDS = ['format', 'checked_at', 'status', 'latest_version', 'latest_ref', 'latest_tag',
  'latest_sha', 'error_code'];
const CATALOG = Object.freeze({ schema_version: '1.0', source: 'update_state', scope: 'user',
  fields: Object.freeze(FIELDS.map((name) => Object.freeze({
    path: name, classification: 'generated_state', application: 'next_update_check',
    editability: { available: false, scope: 'user', reason: 'generated_state' },
  }))) });

export async function dispatchNndUpdateStateRequest(request, response, context) {
  const path = context.url.pathname;
  if (path !== BASE && !path.startsWith(`${BASE}/`)) return false;
  // Permission first, exactly like the sibling family routes.
  requireIntegrationPermission(context.principal, 'nnd.configuration.read');
  if (path === `${BASE}/catalog`) {
    if (request.method !== 'GET') return send(response, 405, { error: 'method_not_allowed' });
    if (context.url.search) throw invalid();
    return send(response, 200, CATALOG);
  }
  if (path !== BASE) return send(response, 404, { error: 'not_found' });
  if (request.method !== 'GET') return send(response, 405, { error: 'method_not_allowed' });
  if (context.url.search) throw invalid();
  const store = context.nndUpdateStateStore;
  if (!store || typeof store.read !== 'function') {
    throw new ContractError('nnd_configuration_unavailable', 'Native update state observation is unavailable.');
  }
  const projected = projectUpdateState(await store.read());
  // Store fields are pattern-length bounded, so the legal payload stays tiny (worst
  // case well under 32 KB); the bound is a projector-drift tripwire like the family
  // baseline routes carry.
  if (Buffer.byteLength(JSON.stringify(projected)) > 65536) throw invalid();
  return send(response, 200, projected);
}

export function createNndUpdateStateStore({ path, installationId, dataId }) {
  if (!ID.test(installationId ?? '') || !ID.test(dataId ?? '') || typeof path !== 'string') throw invalid();
  return Object.freeze({
    async read() {
      return { state: await readUpdateState(path), installationId, dataId, fields: FIELDS };
    },
  });
}

export function projectUpdateState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const { state, installationId, dataId, fields } = value;
  if (typeof installationId !== 'string' || !ID.test(installationId)
    || typeof dataId !== 'string' || !ID.test(dataId) || !Array.isArray(fields)
    || fields.join(',') !== FIELDS.join(',')) throw invalid();
  // Content the store validator refused (absent, corrupt, foreign-shaped) is the sticky
  // honest default: no VALID update-check record exists, and inventing one would lie.
  if (state === null) return { ...identityFields(), schema_version: '1.0', state: 'absent' };
  if (state.format !== 1 || state.status !== 'ready' && state.status !== 'unavailable') throw invalid();
  return { ...identityFields(), schema_version: '1.0', state: 'recorded', format: 1,
    checked_at: timestamp(state.checked_at), status: state.status,
    latest_version: brief(state.latest_version, VERSION), latest_ref: brief(state.latest_ref),
    latest_tag: brief(state.latest_tag), latest_sha: brief(state.latest_sha, SHA),
    error_code: brief(state.error_code) };
  function identityFields() { return { installation_id: installationId, data_id: dataId, scope: 'user' }; }
  // Store-grammar parity: the store accepts any string that Date.parse reads finite
  // and positive; no Z-only or digit-only narrowing on the projection side.
  function timestamp(value) {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || Date.parse(value) <= 0) throw invalid();
    return value;
  }
  function brief(value, pattern) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string' || (pattern ? !pattern.test(value) : value.length > 256)) throw invalid();
    return value;
  }
}
