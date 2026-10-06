// SPDX-License-Identifier: Apache-2.0
/** Native WebSearch settings transaction.
 * Why: the census classifies config/web-search.json (enabled flag plus at most eight
 * canonicalized SearXNG profiles) as an operator-settings family, and the websearch
 * CLI's profile operations now get the same native, authenticated, CAS-receipt path
 * as the 20261005-14 gateway settings family.
 * Invariant: the operation grammar maps one operation to one domain helper —
 * set_enabled re-normalizes the whole document (an enable without a profile keeps the
 * domain's endpoint-required refusal), add_profile appends with a domain-derived
 * unique id, promote_profile moves a profile to primary, remove_profile deletes one
 * (deleting the last profile honestly disables). The search tool reloads this file on
 * every search invocation, so a saved change is honored under application 'next_search',
 * never a restart.
 * Compatibility: the version-1 legacy first-party fields (provider, endpoint, managed)
 * normalize into the version-2 profile list on load; the native surface only projects
 * the version-2 shape. Mechanics mirror the 20261005-14 gateway settings transaction.
 */
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { ContractError } from './ids.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { DEFAULT_WEB_SEARCH_CONFIG, MAX_WEB_SEARCH_CONFIG_BYTES,
  normalizeSearxngEndpoint, normalizeWebSearchConfig, normalizeWebSearchDisplayName,
  normalizeWebSearchProfileId, appendWebSearchProfile, promoteWebSearchProfile,
  removeWebSearchProfile } from './web-search-config.js';
import { readManifestSnapshot, readManifestOperation, transactManifest } from './persistence/manifest-transaction.js';

const idPattern = /^[A-Za-z0-9_-]{1,128}$/u;
const operationPattern = /^[A-Za-z0-9_-]{1,64}$/u;
const revisionPattern = /^(?:absent|[a-f0-9]{64})$/u;
const invalid = () => new ContractError('nnd_web_search_request_invalid', 'Native WebSearch settings request is invalid.');


function authorize(principal, permission) {
  if (typeof principal?.subjectId !== 'string' || !principal.subjectId.trim() || principal.subjectId.length > 256
    || /[\u0000-\u001f\u007f]/u.test(principal.subjectId) || !Array.isArray(principal.permissions)) throw invalid();
  requireIntegrationPermission(principal, permission);
}

/** Canonicalize each operation exactly like the CLI helpers do, so a preview candidate
 * can never differ from the saved value in normalization. Domain semantic failures
 * (duplicate endpoint, missing profile, exhausted ids) propagate their own governed
 * codes; only request-shape violations become the native invalid code. */
function normalizeOperations(operations) {
  // Domain keys per operation, declared as the sorted key list for the exact-key check.
  const opKeys = {
    set_enabled: 'enabled,op', add_profile: 'display_name,endpoint,op',
    promote_profile: 'id,op', remove_profile: 'id,op',
  };
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 16) throw invalid();
  return operations.map((operation) => {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) throw invalid();
    if (Object.keys(operation).sort().join(',') !== opKeys[operation.op]) throw invalid();
    if (operation.op === 'set_enabled' && (operation.enabled === true || operation.enabled === false)) {
      return Object.freeze({ op: 'set_enabled', enabled: operation.enabled });
    }
    if (operation.op === 'add_profile') {
      if (typeof operation.display_name !== 'string' || typeof operation.endpoint !== 'string') throw invalid();
      return Object.freeze({ op: 'add_profile', display_name: normalizeWebSearchDisplayName(operation.display_name),
        endpoint: normalizeSearxngEndpoint(operation.endpoint) });
    }
    if (operation.op === 'promote_profile' || operation.op === 'remove_profile') {
      return Object.freeze({ op: operation.op, id: normalizeWebSearchProfileId(operation.id) });
    }
    throw invalid();
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


/** The CLI's configure/add actions create the file from defaults when absent, so the
 * native transaction mirrors that honestly: reads and previews of an absent file show
 * the sticky defaults (disabled, no profiles), while a present-but-invalid file keeps
 * failing closed. */
function sourceForBoot(snapshot) {
  if (snapshot.state === 'missing') return null;
  if (snapshot.rawBytes?.length > MAX_WEB_SEARCH_CONFIG_BYTES || !snapshot.rawManifest
    || typeof snapshot.rawManifest !== 'object' || Array.isArray(snapshot.rawManifest)) {
    throw new ContractError('nnd_web_search_source_invalid', 'WebSearch settings require explicit repair.');
  }
  try { return normalizeWebSearchConfig(snapshot.rawManifest); }
  catch { throw new ContractError('nnd_web_search_source_invalid', 'WebSearch settings require explicit repair.'); }
}
function source(snapshot) {
  return sourceForBoot(snapshot) ?? DEFAULT_WEB_SEARCH_CONFIG;
}

function validateDocument(document) {
  source({ rawManifest: document, state: 'present' });
  if (Buffer.byteLength(`${JSON.stringify(document, null, 2)}\n`) > MAX_WEB_SEARCH_CONFIG_BYTES) {
    throw new ContractError('nnd_web_search_source_invalid', 'WebSearch settings require explicit repair.');
  }
}

/** Apply the operations through the domain helpers, preserving unknown raw fields
 * privately. Each helper re-normalizes, so a mid-batch semantic failure aborts with
 * the domain's own code and leaves nothing persisted. */
function documentWithOperations(raw, operations) {
  let current = raw === null ? DEFAULT_WEB_SEARCH_CONFIG : normalizeWebSearchConfig(raw);
  for (const operation of operations) {
    if (operation.op === 'set_enabled') {
      current = { ...current, enabled: operation.enabled };
      current = normalizeWebSearchConfig(current);
    } else if (operation.op === 'add_profile') {
      current = appendWebSearchProfile(current, operation.display_name, operation.endpoint);
    } else if (operation.op === 'promote_profile') {
      current = promoteWebSearchProfile(current, operation.id);
    } else {
      current = removeWebSearchProfile(current, operation.id);
    }
  }
  return { ...raw, ...current };
}

function view(snapshot, identity, override) {
  // Invariant: present-but-invalid files stay fail-closed; only preview supplies an
  // explicitly validated override for the proposed content of an absent file.
  const config = override ?? source(snapshot);
  return { ...identity, source_state: snapshot.state === 'missing' ? 'absent' : 'present',
    source_revision: snapshot.revision, resolution_revision: snapshot.revision,
    project_shadowed: false, version: config.version, enabled: config.enabled,
    profiles: config.profiles.map((profile) => ({ ...profile })), application: 'next_search' };
}

function requireRevision(snapshot, request) {
  if (snapshot.revision !== request.expected_revision) {
    throw new ContractError('manifest_revision_conflict', 'Reload WebSearch settings.');
  }
  source(snapshot);
}

function key(principal, identity, operationId) {
  const subject = createHash('sha256').update(JSON.stringify({ ...identity, actor: principal.subjectId })).digest('hex').slice(0, 24);
  return `nndws_${subject}_${operationId}`;
}

function receipt(result, identity, operationId) {
  return { ...identity, operation_id: operationId, persistence: result.persistence, before_revision: result.beforeRevision,
    persisted_revision: result.persistedRevision, application: 'next_search', replayed: result.replayed,
    replay_window: result.replayWindow,
    next_action: result.persistence === 'saved' ? 'next_search' : 'inspect_native_operation' };
}

export function createNndWebSearchSettingsTransaction({ path, installationId, dataId }) {
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
      return { valid: true, ...view({ ...snapshot, rawManifest: proposed }, identity, normalizeWebSearchConfig(proposed)) };
    },
    async save(principal, input) {
      authorize(principal, 'nnd.configuration.manage');
      const request = normalize(input, identity, true);
      // A repeated operation keeps its recorded receipt even when the revision
      // has moved on; the replay check must precede the fast-fail.
      const operationKey = key(principal, identity, request.operation_id);
      const replayed = await readManifestOperation(path, operationKey);
      if (replayed) return receipt(replayed, identity, request.operation_id);
      // Fast-fail with the honest source code (including the domain's semantic
      // refusal for a mid-state operation, e.g. a missing profile) before
      // publishing; the transform rechecks the revision under the lock for atomicity.
      const snapshot = await readManifestSnapshot(path);
      requireRevision(snapshot, request);
      const proposed = documentWithOperations(snapshot.rawManifest, request.operations);
      validateDocument(proposed);
      const result = await transactManifest({ path, expectedRevision: request.expected_revision,
        operationId: operationKey,
        payload: { contract: 'nnd-web-search-settings-v1', identity, actor: principal.subjectId,
          operations: request.operations.map((operation) => ({ ...operation })) },
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
