// SPDX-License-Identifier: Apache-2.0
/** Native secrets metadata settings surface over /v1/nnd/configuration/secrets.
 * Why: the census classifies six secrets rows (label, kind, scope, metadata.{name},
 * fields.{field}, enabled) observed through the native broker over the encrypted-at-rest
 * vault secrets/vault.json. This surface is the READ half: it projects exactly the
 * broker's redaction-safe publicSecret envelope — labels, kinds, scopes, public
 * metadata, FIELD NAMES (never values), and enabled state — and the catalog. Every
 * mutation (create/update/rotate/enable/delete/audit) stays on the runtime broker
 * surface and its own action rows; this settings family must never become a
 * vault/master-key file editor.
 * Invariant: secret VALUES never project, not even encrypted material; a corrupt or
 * unreadable vault fails closed with the vault's own codes (never an empty list,
 * which would look like "no secrets configured"); a drifted projection refuses with
 * its own server-side code, like the compatibility family.
 * Application: 'next_secret_use' — records change live in the vault, and their VALUES
 * reach a consumer only at the next SecretBroker.withSecret consumption; the settings
 * read does not apply or activate anything.
 */
import { lstat } from 'node:fs/promises';
import { ContractError } from './ids.js';
import { send } from './secret-broker-server.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { LOCAL_SECRET_REALM, SECRET_KINDS, SECRET_SCOPE_KINDS } from './secret-contracts.js';

const BASE = '/v1/nnd/configuration/secrets';
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SECRET_ID = /^sec_[0-9a-f-]{36}$/u;
const ISO_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
// Loose ceiling, not derived: the vault itself carries no record cap, so the bound is
// sized for a local realm's several dozen public records (metadata alone can reach
// ~64k characters per record); beyond it the projection is drift and fails closed.
const RESPONSE_BOUND = 2_097_152 + 65_536;
const requestInvalid = () => new ContractError('nnd_secrets_request_invalid', 'Native secrets request is invalid.');
const projection = () => new ContractError('nnd_secrets_projection_invalid', 'Secrets settings refused a drifted projection.');

const READ_PERMISSION = 'nnd.configuration.read';
const field = (path) => Object.freeze({ path, classification: 'operator_setting',
  application: 'next_secret_use', scope: 'user', required_permission: READ_PERMISSION,
  editability: { available: false, scope: 'user', reason: 'secret_broker_actions' } });
const CATALOG = Object.freeze({ schema_version: '1.0', source: 'secrets', scope: 'user',
  fields: Object.freeze([
    field('label'), field('kind'), field('scope'), field('metadata.{name}'),
    field('fields.{field}'), field('enabled'),
  ]) });

export async function dispatchNndSecretsRequest(request, response, context) {
  const path = context.url.pathname;
  if (path !== BASE && !path.startsWith(`${BASE}/`)) return false;
  const action = path === BASE ? 'list' : path === `${BASE}/catalog` ? 'catalog' : null;
  if (!action) return send(response, 404, { error: 'not_found' });
  requireIntegrationPermission(context.principal, READ_PERMISSION);
  if (request.method !== 'GET') return send(response, 405, { error: 'method_not_allowed' });
  if (context.url.search) throw requestInvalid();
  const service = context.nndSecretsSettingsService;
  if (!service || typeof service.list !== 'function') {
    throw new ContractError('nnd_configuration_unavailable', 'Native secrets settings are unavailable.');
  }
  if (action === 'catalog') return send(response, 200, CATALOG);
  const projected = projectSecretsList(await service.list());
  if (projected === null || Buffer.byteLength(JSON.stringify(projected)) > RESPONSE_BOUND) throw projection();
  return send(response, 200, projected);
}

export function createNndSecretsSettingsService({ broker, vaultPath, installationId, dataId }) {
  if (!ID.test(installationId ?? '') || !ID.test(dataId ?? '')
    || typeof vaultPath !== 'string' || !vaultPath || !broker || typeof broker.list !== 'function') {
    throw requestInvalid();
  }
  return Object.freeze({
    async list() {
      const [sourceState, records] = await Promise.all([
        absentState(vaultPath), broker.list()]);
      return { installationId: installationId, dataId: dataId, sourceState,
        count: records.length, records };
    },
  });
}

const RECORD_KEYS = 'createdAt,enabled,fields,id,kind,label,lastUsedAt,metadata,'
  + 'realm,rotatedAt,scope,updatedAt,useCount';

export function projectSecretsList(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'count,dataId,installationId,records,sourceState'
    || !ID.test(value.installationId ?? '') || !ID.test(value.dataId ?? '')
    || !['present', 'absent'].includes(value.sourceState) || !Array.isArray(value.records)
    || (value.sourceState === 'absent' && value.records.length !== 0)
    || value.records.length !== value.count) throw projection();
  const secrets = value.records.map((record) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || Object.keys(record).sort().join(',') !== RECORD_KEYS) throw projection();
    if (!SECRET_ID.test(record.id ?? '') || record.realm !== LOCAL_SECRET_REALM) throw projection();
    const label = record.label;
    if (typeof label !== 'string' || label.length < 1 || label.length > 96
      || /[\x00-\x1f\x7f]/u.test(label)) throw projection();
    if (!SECRET_KINDS.includes(record.kind)) throw projection();
    if (record.enabled !== true && record.enabled !== false) throw projection();
    return { id: record.id, realm: record.realm, label,
      kind: record.kind,
      scope: projectScope(record.scope),
      metadata: projectMetadata(record.metadata),
      fields: projectFieldNames(record.fields),
      enabled: record.enabled,
      created_at: stamp(record.createdAt, false), updated_at: stamp(record.updatedAt, false),
      rotated_at: stamp(record.rotatedAt, true), last_used_at: stamp(record.lastUsedAt, true),
      use_count: useCount(record.useCount) };
  });
  return { schema_version: '1.0', installation_id: value.installationId, data_id: value.dataId,
    scope: 'user', source_state: value.sourceState, count: secrets.length, secrets,
    application: 'next_secret_use' };
}

function projectScope(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'id,kind' || !SECRET_SCOPE_KINDS.includes(value.kind)
    || typeof value.id !== 'string' || value.id.length < 1 || value.id.length > 128
    || /[\x00-\x1f\x7f]/u.test(value.id)) throw projection();
  return { kind: value.kind, id: value.id };
}

function projectMetadata(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw projection();
  const entries = Object.entries(value);
  if (entries.length > 32) throw projection();
  return entries.map(([name, item]) => {
    if (!FIELD_NAME.test(name)) throw projection();
    if (item === null || typeof item === 'boolean') return [name, item];
    if (typeof item === 'string' && item.length <= 2_000
      && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(item)) return [name, item];
    if (Array.isArray(item) && item.length <= 64
      && item.every((entry) => typeof entry === 'string' && entry.length <= 256)
      && item.every((entry, index) => index === 0 || String(item[index - 1]) <= String(entry))) {
      return [name, item.slice()];
    }
    throw projection();
  }).reduce((merged, [name, item]) => { merged[name] = item; return merged; }, {});
}

function projectFieldNames(value) {
  if (!Array.isArray(value) || value.length > 16) throw projection();
  const seen = new Set();
  return value.map((name, index) => {
    if (typeof name !== 'string' || !FIELD_NAME.test(name)
      || seen.has(name) || (index > 0 && String(value[index - 1]) >= String(name))) throw projection();
    seen.add(name);
    return name;
  });
}

function stamp(value, nullable) {
  if (value === null && nullable) return null;
  if (typeof value === 'string' && ISO_STAMP.test(value)) return value;
  throw projection();
}

function useCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw projection();
  return value;
}

/** The vault is absent when the file does not exist yet; anything else either exists
 * (possibly corrupt) or is a filesystem error the vault read will report itself. */
async function absentState(vaultPath) {
  try { await lstat(vaultPath); return 'present'; }
  catch (error) { if (error.code === 'ENOENT') return 'absent'; throw error; }
}
