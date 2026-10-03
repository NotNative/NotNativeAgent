// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { ContractError } from './ids.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { readNndConfigurationSources } from './nnd-configuration-sources.js';
import { readManifestOperation, readManifestSnapshot, transactManifest } from './persistence/manifest-transaction.js';

const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const REVISION = /^(?:absent|[a-f0-9]{64})$/u;
const ROOT_BYTES = 4096;
const DOCUMENT_KEYS = ['protocol', 'installation_id', 'data_id', 'primary', 'secondary'];
const GRANT_KEYS = ['root', 'id', 'device', 'inode'];
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const fail = (code = 'nnd_workspace_grant_invalid') => new ContractError(code, 'Native workspace grant could not be verified.');
const workspaceId = root => `ws_${createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex').slice(0, 24)}`;
// Primary identity must match nativeNndPrincipal(config.workspaceRoot), which
// already owns persisted single-root sessions and hashes that string verbatim.
const primaryWorkspaceId = configuredRoot => `ws_${createHash('sha256').update(configuredRoot).digest('hex').slice(0, 24)}`;
export function grantFileIdentity(info) {
  if (typeof info.dev !== 'bigint' || typeof info.ino !== 'bigint') throw fail();
  return { device: String(info.dev), inode: String(info.ino) };
}

async function canonicalGrant(path) {
  if (typeof path !== 'string' || path.length < 1 || Buffer.byteLength(path) > ROOT_BYTES || !isAbsolute(path)
    || /[\u0000-\u001f\u007f]/u.test(path) || path.startsWith('\\\\') || path.startsWith('\\?\\')) throw fail();
  const selected = resolve(path);
  if (!same(path, selected)) throw fail();
  try {
    for (let cursor = selected; ; cursor = dirname(cursor)) {
      const info = await lstat(cursor, { bigint: true });
      if (info.isSymbolicLink()) throw fail();
      if (cursor === parse(cursor).root) break;
    }
    const root = await realpath(selected);
    if (!same(selected, root)) throw fail();
    const info = await lstat(root, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) throw fail();
    return Object.freeze({ root, id: workspaceId(root), ...grantFileIdentity(info) });
  } catch { throw fail(); }
}

function validGrant(value) {
  return record(value) && exact(value, GRANT_KEYS) && typeof value.root === 'string'
    && /^ws_[a-f0-9]{24}$/u.test(value.id) && typeof value.device === 'string'
    && /^\d+$/u.test(value.device) && typeof value.inode === 'string' && /^\d+$/u.test(value.inode);
}
async function verifyGrant(value, expectedId) {
  if (!validGrant(value)) throw fail();
  const actual = await canonicalGrant(value.root);
  if (value.id !== (expectedId ?? actual.id)
    || ['root', 'device', 'inode'].some(key => actual[key] !== value[key])) throw fail('nnd_workspace_grant_identity_mismatch');
  return expectedId === undefined ? actual : Object.freeze({ ...actual, id: expectedId });
}
function exact(value, keys) { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function authorize(principal, permission) {
  if (typeof principal?.subjectId !== 'string' || !principal.subjectId.trim() || principal.subjectId.length > 256
    || !Array.isArray(principal.permissions)) throw fail();
  requireIntegrationPermission(principal, permission);
}
function operationKey(principal, identity, id) {
  const key = createHash('sha256').update(JSON.stringify({ ...identity, actor: principal.subjectId })).digest('hex').slice(0, 24);
  const request = createHash('sha256').update(id).digest('hex');
  return `nndwsg_${key}_${request}`;
}
function receipt(value, identity, id) {
  return Object.freeze({ ...identity, operation_id: id, persistence: value.persistence,
    before_revision: value.beforeRevision, persisted_revision: value.persistedRevision,
    replayed: value.replayed, replay_window: value.replayWindow, application: 'not_applied' });
}

export function createNndWorkspaceGrantService({ paths, installationId, dataId }) {
  if (!isAbsolute(paths?.config ?? '') || !ID.test(installationId ?? '') || !ID.test(dataId ?? '')) throw fail();
  const identity = Object.freeze({ installation_id: installationId, data_id: dataId });
  const path = join(paths.config, 'nnd-workspace-grants.json');
  async function currentPrimary() {
    const context = await readNndConfigurationSources(paths);
    const configuredRoot = context.config.workspaceRoot;
    return Object.freeze({ ...await canonicalGrant(configuredRoot), id: primaryWorkspaceId(configuredRoot) });
  }
  const read = principal => readGrants({ path, identity, currentPrimary }, principal);
  async function save(principal, input) {
    authorize(principal, 'nnd.workspace.manage');
    if (!record(input) || !exact(input, ['installation_id', 'data_id', 'expected_revision', 'operation_id', 'secondary_root'])
      || input.installation_id !== installationId || input.data_id !== dataId
      || !REVISION.test(input.expected_revision ?? '') || !ID.test(input.operation_id ?? '')
      || !(input.secondary_root === null || typeof input.secondary_root === 'string')) throw fail();
    const primary = await currentPrimary();
    const secondary = input.secondary_root === null ? null : await canonicalGrant(input.secondary_root);
    if (secondary && (same(secondary.root, primary.root) || secondary.id === primary.id)) throw fail();
    const document = { protocol: '1.0', ...identity, primary, secondary };
    let failure;
    const checked = async (value, expected) => {
      try { await validateDocument(value, identity, expected); }
      catch (error) { failure = error; throw error; }
    };
    let result;
    try { result = await transactManifest({ path, expectedRevision: input.expected_revision,
      operationId: operationKey(principal, identity, input.operation_id),
      payload: { ...identity, actor: principal.subjectId, request: input },
      transform: async (previous, snapshot) => {
        if (snapshot.state !== 'missing') {
          if (previous === null) throw fail();
          try { await validatePrimary(previous, identity, primary); }
          catch (error) { failure = error; throw error; }
        }
        await checked(document, await currentPrimary());
        return document;
      },
      validate: async (next) => checked(next, await currentPrimary()) }); }
    catch (error) { if (error.code === 'manifest_validation_failed' && failure) throw failure; throw error; }
    return receipt(result, identity, input.operation_id);
  }
  async function operation(principal, id) {
    authorize(principal, 'nnd.workspace.read');
    if (!ID.test(id ?? '')) throw fail();
    const result = await readManifestOperation(path, operationKey(principal, identity, id));
    return result ? receipt(result, identity, id) : null;
  }
  return Object.freeze({ read, save, operation });
}

async function readGrants({ path, identity, currentPrimary }, principal) {
  authorize(principal, 'nnd.workspace.read');
  const primary = await currentPrimary();
  const snapshot = await readManifestSnapshot(path);
  let secondary = null;
  if (snapshot.state !== 'missing') {
    const document = snapshot.rawManifest;
    await validatePrimary(document, identity, primary);
    secondary = document.secondary === null ? null : await verifyGrant(document.secondary);
    if (secondary && (same(secondary.root, primary.root) || secondary.id === primary.id)) throw fail();
  }
  return Object.freeze({ ...identity, revision: snapshot.revision, primary, secondary,
    application: 'not_applied', selection_enabled: false });
}

async function validateDocument(value, identity, primary) {
  await validatePrimary(value, identity, primary);
  if (value.secondary !== null) {
    const secondary = await verifyGrant(value.secondary);
    if (same(primary.root, secondary.root) || primary.id === secondary.id) throw fail();
  }
}

async function validatePrimary(value, identity, primary) {
  if (!record(value) || !exact(value, DOCUMENT_KEYS) || value.protocol !== '1.0'
    || value.installation_id !== identity.installation_id || value.data_id !== identity.data_id) throw fail();
  const stored = await verifyGrant(value.primary, primary.id);
  if (Object.keys(primary).some(key => primary[key] !== stored[key])) throw fail('nnd_workspace_grant_identity_mismatch');
}
