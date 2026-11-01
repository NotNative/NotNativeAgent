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
import { ContractError } from './ids.js';
import { DEFAULT_WEB_FETCH_CONFIG, MAX_WEB_FETCH_CONFIG_BYTES, normalizeTrustedOrigin, normalizeWebFetchConfig } from './web-fetch-config.js';
import { createDesktopSettingsTransaction } from './desktop-settings-transaction.js';
import { DESKTOP_REVISION } from './desktop-request-grammar.js';
import { DESKTOP_OPERATION_ID } from './desktop-request-grammar.js';

const operationPattern = DESKTOP_OPERATION_ID;
const revisionPattern = DESKTOP_REVISION;
const invalid = () => new ContractError('desktop_web_fetch_request_invalid', 'Native WebFetch settings request is invalid.');

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
    throw new ContractError('desktop_web_fetch_source_invalid', 'WebFetch settings require explicit repair.');
  }
  try { return normalizeWebFetchConfig(snapshot.rawManifest); }
  catch { throw new ContractError('desktop_web_fetch_source_invalid', 'WebFetch settings require explicit repair.');
  }
}
function source(snapshot) {
  return sourceForBoot(snapshot) ?? DEFAULT_WEB_FETCH_CONFIG;
}

function validateDocument(document) {
  source({ rawManifest: document, state: 'present' });
  if (Buffer.byteLength(`${JSON.stringify(document, null, 2)}\n`) > MAX_WEB_FETCH_CONFIG_BYTES) {
    throw new ContractError('desktop_web_fetch_source_invalid', 'WebFetch settings require explicit repair.');
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

export function createDesktopWebFetchSettingsTransaction({ path, installationId, dataId }) {
  return createDesktopSettingsTransaction({
    path, installationId, dataId, invalid,
    keyPrefix: 'nndwft_', application: 'next_fetch', conflictLabel: 'WebFetch',
    normalize,
    document: (raw, request) => documentWithOperations(raw, request.operations),
    validate: validateDocument,
    verifySource: source,
    readView: (snapshot, identity) => view(snapshot, identity),
    previewView: (snapshot, identity, request, proposed) => view(snapshot, identity, normalizeWebFetchConfig(proposed)),
    payload: (request, identity, principal) => ({ contract: 'desktop-web-fetch-settings-v1', identity,
      actor: principal.subjectId, operations: request.operations.map(({ op, origin }) => ({ op, origin })) }),
  });
}
