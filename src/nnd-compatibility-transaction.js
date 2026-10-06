// SPDX-License-Identifier: Apache-2.0
/** Native compatibility-service settings transaction.
 * Why: the census classifies config/opencode.json as seven compatibility_service rows —
 * the fixed wire identity (hostname, port, Basic auth credentials) and login
 * auto-start preference of NNA's OpenCode wiring surface. The service reads the file
 * at its next start (ensureServiceConfiguration), so a saved change classifies under
 * application 'next_service_start'.
 * Invariant: secret values never project — reads show a presence source only
 * (opencodePublicStatus semantics) and a candidate's password value is validated
 * without echoing; a candidate is a full document view (every editable field present)
 * merged over the stored secret, validated by the same normalizeOpenCodeConfig the
 * cli and service use. Mechanics mirror the WebFetch settings transaction.
 */
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { ContractError } from './ids.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { DEFAULT_OPENCODE_CONFIG, normalizeOpenCodeConfig, opencodePublicStatus }
  from './opencode/config.js';
import { readManifestSnapshot, readManifestOperation, transactManifest } from './persistence/manifest-transaction.js';

const idPattern = /^[A-Za-z0-9_-]{1,128}$/u;
const operationPattern = /^[A-Za-z0-9_-]{1,64}$/u;
const revisionPattern = /^(?:absent|[a-f0-9]{64})$/u;
const invalid = () => new ContractError('nnd_compatibility_request_invalid', 'Native compatibility settings request is invalid.');
const sourceInvalid = () => new ContractError('nnd_compatibility_source_invalid', 'Compatibility settings require explicit repair.');
const CANDIDATE = ['enabled', 'hostname', 'port', 'username'];
const PASSWORD_ACTIONS = ['keep', 'replace', 'clear'];

function authorize(principal, permission) {
  if (typeof principal?.subjectId !== 'string' || !principal.subjectId.trim() || principal.subjectId.length > 256
    || /[\u0000-\u001f\u007f]/u.test(principal.subjectId) || !Array.isArray(principal.permissions)) throw invalid();
  requireIntegrationPermission(principal, permission);
}

/** An absent file bootstraps the domain's sticky defaults exactly like the CLI does;
 * a present-but-invalid file keeps failing closed (repair, never a guessed shape). */
function sourceForBoot(snapshot) {
  if (snapshot.state === 'missing') return null;
  if (!snapshot.rawManifest || typeof snapshot.rawManifest !== 'object'
    || Array.isArray(snapshot.rawManifest)) throw sourceInvalid();
  try { return normalizeOpenCodeConfig(snapshot.rawManifest); }
  catch { throw sourceInvalid(); }
}
function source(snapshot) { return sourceForBoot(snapshot) ?? DEFAULT_OPENCODE_CONFIG; }

function normalizeCandidate(view, password) {
  if (!password || typeof password !== 'object' || Array.isArray(password)
    || !PASSWORD_ACTIONS.includes(password.action)
    || (password.value === undefined) === (password.action === 'replace')) throw invalid();
  if (!view || typeof view !== 'object' || Array.isArray(view)
    || Object.keys(view).some((key) => !CANDIDATE.includes(key))) throw invalid();
  if ('enabled' in view && view.enabled !== true && view.enabled !== false) throw invalid();
  return { view, password };
}

function normalize(input, identity, save) {
  const keys = ['installation_id', 'data_id', 'scope', 'expected_revision', 'expected_resolution_revision',
    'view', 'password', ...(save ? ['operation_id'] : [])];
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !keys.includes(key))
    || Object.entries(identity).some(([key, value]) => input[key] !== value)
    || !revisionPattern.test(input.expected_revision ?? '')
    || input.expected_resolution_revision !== input.expected_revision
    || (save && !operationPattern.test(input.operation_id ?? ''))) throw invalid();
  return { ...input, ...normalizeCandidate(input.view, input.password) };
}

/** Merge the candidate over the stored document, preserving the stored secret under
 * 'keep' and stamping updated_at exactly like the service's own configuration writes.
 * The domain's own normalize is the only validator: unknown or out-of-grammar values
 * fail with its honest domain codes (hostname, port, username, bind-exposure). */
function documentWithCandidate(raw, request) {
  const current = raw === null ? DEFAULT_OPENCODE_CONFIG : normalizeOpenCodeConfig(raw);
  const candidate = { ...current };
  for (const key of CANDIDATE) if (request.view[key] !== undefined) candidate[key] = request.view[key];
  if (request.password.action === 'replace') candidate.password = request.password.value;
  if (request.password.action === 'clear') candidate.password = null;
  const prepared = normalizeOpenCodeConfig(candidate);
  return { version: prepared.version, enabled: prepared.enabled, hostname: prepared.hostname,
    port: prepared.port, username: prepared.username,
    ...(prepared.password === null ? {} : { password: prepared.password }),
    updated_at: new Date().toISOString() };
}

function credentialStatus(config, environment) {
  const status = opencodePublicStatus(config, environment ?? process.env);
  return { configured: status.configured, source: status.password_source };
}

function view(snapshot, identity, override, environment) {
  const config = override ?? source(snapshot);
  return { ...identity, source_state: snapshot.state === 'missing' ? 'absent' : 'present',
    source_revision: snapshot.revision, resolution_revision: snapshot.revision,
    project_shadowed: false, version: config.version, enabled: config.enabled,
    hostname: config.hostname, port: config.port, username: config.username,
    password: credentialStatus(config, environment), updated_at: config.updated_at ?? null,
    application: 'next_service_start' };
}

function requireRevision(snapshot, request) {
  if (snapshot.revision !== request.expected_revision) {
    throw new ContractError('manifest_revision_conflict', 'Reload compatibility settings.');
  }
  source(snapshot);
}

function validateDocument(document) {
  source({ rawManifest: document, state: 'present' });
}

function key(principal, identity, operationId) {
  const subject = createHash('sha256').update(JSON.stringify({ ...identity, actor: principal.subjectId })).digest('hex').slice(0, 24);
  return `nndpat_${subject}_${operationId}`;
}

function receipt(result, identity, operationId) {
  return { ...identity, operation_id: operationId, persistence: result.persistence, before_revision: result.beforeRevision,
    persisted_revision: result.persistedRevision, application: 'next_service_start', replayed: result.replayed,
    replay_window: result.replayWindow,
    next_action: result.persistence === 'saved' ? 'next_service_start' : 'inspect_native_operation' };
}

export function createNndCompatibilitySettingsTransaction({ path, installationId, dataId, environment }) {
  if (typeof path !== 'string' || !isAbsolute(path) || !idPattern.test(installationId ?? '')
    || !idPattern.test(dataId ?? '')) throw invalid();
  const identity = { installation_id: installationId, data_id: dataId, scope: 'user' };
  return Object.freeze({
    async read(principal) {
      authorize(principal, 'nnd.configuration.read');
      return view(await readManifestSnapshot(path), identity, undefined, environment);
    },
    async preview(principal, input) {
      authorize(principal, 'nnd.configuration.manage');
      const request = normalize(input, identity, false);
      const snapshot = await readManifestSnapshot(path);
      const proposed = documentWithCandidate(snapshot.rawManifest, request);
      requireRevision(snapshot, request);
      return { valid: true, ...view({ ...snapshot, rawManifest: proposed }, identity,
        normalizeOpenCodeConfig(proposed), environment) };
    },
    async save(principal, input) {
      authorize(principal, 'nnd.configuration.manage');
      const request = normalize(input, identity, true);
      const operationKey = key(principal, identity, request.operation_id);
      const replayed = await readManifestOperation(path, operationKey);
      if (replayed) return receipt(replayed, identity, request.operation_id);
      const snapshot = await readManifestSnapshot(path);
      requireRevision(snapshot, request);
      const result = await transactManifest({ path, expectedRevision: request.expected_revision,
        operationId: operationKey,
        payload: { contract: 'nnd-compatibility-settings-v1', identity, actor: principal.subjectId,
          password_action: request.password.action },
        transform: (raw, meta) => {
          requireRevision({ rawManifest: raw, revision: meta.revision, state: meta.state }, request);
          return documentWithCandidate(raw, request);
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
