// SPDX-License-Identifier: Apache-2.0
/** Native WebSearch settings routes over /v1/desktop/configuration/web-search.
 * Why: census rows for config/web-search.json (the enabled flag plus the canonical
 * SearXNG profile list) need the authenticated native surface the gateway settings
 * family established in 20261005-14.
 * Invariant: reads show the exact profile order (primary first, by domain design);
 * preview never persists; receipts class application as 'next_search' because the
 * search tool reloads the file on every search invocation.
 * Compatibility: the version-1 legacy fields (provider, endpoint, managed) normalize
 * into the version-2 profiles on load and are not projected by this surface.
 */
import { ContractError } from './ids.js';
import { createDesktopSettingsDispatcher } from './desktop-settings-routes.js';
import { MAX_WEB_SEARCH_PROFILES, normalizeSearxngEndpoint, normalizeWebSearchProfileId } from './web-search-config.js';
import { SHA256_HEX } from './digests.js';
import { DESKTOP_REVISION } from './desktop-request-grammar.js';
import { DESKTOP_ID } from './desktop-request-grammar.js';

const BASE = '/v1/desktop/configuration/web-search';
const OPERATION = /^\/v1\/desktop\/configuration\/web-search\/operations\/([A-Za-z0-9_-]{1,64})$/u;
const ID = DESKTOP_ID;
// An absent file legitimately reads and previews under the absent revision base.
const REVISION = DESKTOP_REVISION;
const PERSISTED_REVISION = SHA256_HEX;
const invalid = () => new ContractError('desktop_web_search_request_invalid', 'Native WebSearch settings request is invalid.');

const EDITABLE = 'desktop.configuration.manage';
function field(path, definition) {
  return Object.freeze({ path, classification: 'operator_setting', scope: 'user',
    required_permission: EDITABLE, application: 'next_search', ...definition });
}
const CATALOG = Object.freeze({ schema_version: '1.0', source: 'web_search', scope: 'user',
  fields: Object.freeze([
    field('enabled', { editability: { available: true, scope: 'user', required_permission: 'desktop.configuration.manage' } }),
    field('profiles', { type: 'array', operations: ['add_profile', 'promote_profile', 'remove_profile'],
      editability: { available: true, scope: 'user', required_permission: 'desktop.configuration.manage' } }),
    field('version', { classification: 'generated_state',
      editability: { available: false, scope: 'user', reason: 'generated_state' } }),
  ]) });

export const dispatchDesktopWebSearchRequest = createDesktopSettingsDispatcher({
  base: BASE, operationPattern: OPERATION, serviceKey: 'desktopWebSearchSettingsService',
  catalog: CATALOG, invalid, projectView, projectReceipt,
  // Why 131,072 bytes both ways: the domain caps the stored file at 65,536, and a
  // legal add_profile may carry an endpoint near that bound before the transform's
  // file-size validation refuses the result; the native envelope doubles it so any
  // legal domain state round-trips.
  requestLimit: 131072, responseLimit: 131072,
  unavailableMessage: 'Native WebSearch configuration is unavailable.',
});

function identity(value) {
  if (!value || typeof value !== 'object' || !ID.test(value.installation_id ?? '')
    || !ID.test(value.data_id ?? '') || value.scope !== 'user' || value.application !== 'next_search') throw invalid();
  return { installation_id: value.installation_id, data_id: value.data_id, scope: 'user' };
}
function revision(value) { if (typeof value !== 'string' || !REVISION.test(value)) throw invalid(); return value; }
function persistedRevision(value) {
  if (value === null) return null;
  if (typeof value === 'string' && PERSISTED_REVISION.test(value)) return value;
  throw invalid();
}
function fieldValues(value) {
  if (value.version !== 2 || typeof value.enabled !== 'boolean' || !Array.isArray(value.profiles)
    || value.profiles.length > MAX_WEB_SEARCH_PROFILES) throw invalid();
  const seen = new Set(), endpoints = new Set();
  const profiles = value.profiles.map((profile) => {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)
      || Object.keys(profile).sort().join(',') !== 'display_name,endpoint,id,managed,provider') throw invalid();
    if (profile.provider !== 'searxng' || typeof profile.display_name !== 'string'
      || profile.display_name.length < 1 || Array.from(profile.display_name).length > 128
      || profile.managed !== true && profile.managed !== false) throw invalid();
    let endpoint;
    try { endpoint = normalizeSearxngEndpoint(profile.endpoint); } catch { throw invalid(); }
    normalizeWebSearchProfileId(profile.id);
    seen.add(profile.id); endpoints.add(endpoint);
    return { id: profile.id, display_name: profile.display_name, provider: 'searxng', endpoint, managed: profile.managed };
  });
  if (seen.size !== profiles.length || endpoints.size !== profiles.length) throw invalid();
  return { version: value.version, enabled: value.enabled, profiles };
}
function projectView(value, action) {
  const selected = identity(value);
  const sourceRevision = revision(value.source_revision), resolutionRevision = revision(value.resolution_revision);
  if (resolutionRevision !== sourceRevision || value.project_shadowed !== false
    || !['absent', 'present'].includes(value.source_state)) throw invalid();
  const view = { schema_version: '1.0', ...selected, source_state: value.source_state,
    source_revision: sourceRevision,
    resolution_revision: resolutionRevision, project_shadowed: false, ...fieldValues(value),
    application: 'next_search' };
  if (action === 'read') return view;
  if (value.valid !== true) throw invalid();
  return { valid: true, expected_revision: sourceRevision, resolution_revision: resolutionRevision,
    application: 'next_search', view };
}
function projectReceipt(value) {
  const selected = identity(value);
  if (!['saved', 'unpublished', 'unknown'].includes(value.persistence)
    || typeof value.operation_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(value.operation_id)
    || value.replay_window !== 'last_128_operations') throw invalid();
  return { ...selected, operation_id: value.operation_id, persistence: value.persistence,
    before_revision: revision(value.before_revision),
    // Invariant: a saved receipt necessarily overwrote some bytes, so its persisted
    // revision is always a digest; the fail-closed pairing stays (an invalid digest
    // rejects instead of degrading to null).
    persisted_revision: persistedRevision(value.persisted_revision),
    application: 'next_search',
    next_action: value.persistence === 'saved' ? 'next_search' : 'inspect_native_operation',
    replayed: value.replayed === true, replay_window: 'last_128_operations' };
}
