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
import { ContractError } from './ids.js';
import { DEFAULT_OPENCODE_CONFIG, normalizeOpenCodeConfig, opencodePublicStatus }
  from './opencode/config.js';
import { createDesktopSettingsTransaction } from './desktop-settings-transaction.js';
import { DESKTOP_REVISION } from './desktop-request-grammar.js';
import { DESKTOP_OPERATION_ID } from './desktop-request-grammar.js';

const operationPattern = DESKTOP_OPERATION_ID;
const revisionPattern = DESKTOP_REVISION;
const invalid = () => new ContractError('desktop_compatibility_request_invalid', 'Native compatibility settings request is invalid.');
const sourceInvalid = () => new ContractError('desktop_compatibility_source_invalid', 'Compatibility settings require explicit repair.');
const CANDIDATE = ['enabled', 'hostname', 'port', 'username'];
const PASSWORD_ACTIONS = ['keep', 'replace', 'clear'];

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
  // At parity with the header and the census: the candidate is a FULL document view —
  // all four wire keys are required (sparse saves would re-stamp generated state while
  // rewriting nothing, reindexing every concurrent client). Types stay the domain's
  // own: the merged document is validated by normalizeOpenCodeConfig.
  if (!password || typeof password !== 'object' || Array.isArray(password)
    || !PASSWORD_ACTIONS.includes(password.action)
    || (password.action === 'replace') !== ('value' in password)) throw invalid();
  if (!view || typeof view !== 'object' || Array.isArray(view)
    || Object.keys(view).some((key) => !CANDIDATE.includes(key))
    || !CANDIDATE.every((key) => key in view)) throw invalid();
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

function validateDocument(document) {
  source({ rawManifest: document, state: 'present' });
}

export function createDesktopCompatibilitySettingsTransaction({ path, installationId, dataId, environment }) {
  return createDesktopSettingsTransaction({
    path, installationId, dataId, invalid,
    keyPrefix: 'nndpat_', application: 'next_service_start', conflictLabel: 'compatibility',
    normalize,
    document: (raw, request) => documentWithCandidate(raw, request),
    validate: validateDocument,
    verifySource: source,
    readView: (snapshot, identity) => view(snapshot, identity, undefined, environment),
    previewView: (snapshot, identity, request, proposed) =>
      view(snapshot, identity, normalizeOpenCodeConfig(proposed), environment),
    payload: (request, identity, principal) => ({ contract: 'desktop-compatibility-settings-v1', identity,
      actor: principal.subjectId, password_action: request.password.action }),
  });
}
