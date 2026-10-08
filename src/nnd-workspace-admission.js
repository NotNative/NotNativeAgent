// SPDX-License-Identifier: Apache-2.0
/** Native workspace ADMISSION surface (F1: projects / execution roots lane).
 * Why: F1's admission contract needs one durable, idempotently replayable user
 * path from "a path somebody typed" to "an admitted, config-anchored identity"
 * that coexists with the attached workspace root instead of shadowing it, and
 * it must not invent a second identity space: ws_ hashes stay THE workspace
 * identity (the shared kernel vocabulary), canonicalization is the grant
 * kernel's own fail-closed walk (readCanonicalGrant), and durability is the
 * manifest-transaction family with idempotent operation receipts.
 * Invariant: single writer per file — this store NEVER writes the grant file
 * (nnd-workspace-grants.json stays the grant surface alone) and the grant
 * surface keeps its primary/secondary grammar untouched. The attached root
 * and, when present, the granted secondary root are visible in the inventory
 * without any composed transaction, and admitting a root the configuration
 * already anchors (attached or granted) is REFUSED here
 * (nnd_workspace_admission_root_conflict). The reverse order — granting a
 * root an admission row already anchors — is redundancy, not corruption: the
 * inventory simply presents both projections and consumers dedupe by the
 * shared ws_ id, so no read ever refuses over an operator's grant action.
 * Security: inventory reads need nnd.workspace.read; admit and revoke need
 * nnd.workspace.manage; every read re-verifies every stored root against the
 * live disk through the kernel's fail-closed walk (absolute, control-ascii
 * free, no UNC or \\?\ literal, no symlink ancestors, realpath-equal, 4096
 * transport bound). A stored row that fails its probe — including a vanished
 * directory — fails closed as nnd_workspace_admission_identity_mismatch, and
 * a drifted grant document or granted root fails closed with the GRANT
 * surface's own error vocabulary; an inventory is never empty-looking while
 * the configuration is unusable. Mutations publish protocol-1.0 documents of
 * exactly { protocol, installation_id, data_id, admitted[] } with rows of
 * exactly { root, id, device, inode, admitted_at, operation_id } and answer
 * with settings-grammar receipts (operation_id, persistence, revisions,
 * replayed, application: 'not_applied'; the GUI-only admission never applies
 * anything to the runtime). Like the grant surface, the operation bodies are
 * module-level over a frozen context so each function stays inside the
 * function-length gate.
 */
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { ContractError } from './ids.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { readManifestOperation, readManifestSnapshot, transactManifest } from './persistence/manifest-transaction.js';
import { readCanonicalGrant, primaryWorkspaceId, validatePrimary, workspaceId } from './nnd-workspace-grants.js';
import { readNndConfigurationSources } from './nnd-configuration-sources.js';

const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const REVISION = /^(?:absent|[a-f0-9]{64})$/u;
const ROOT_BYTES = 4096;
const ROOT_MAX = 32_768;
const GRANT_KEYS = ['root', 'id', 'device', 'inode'];
const DOCUMENT_KEYS = ['protocol', 'installation_id', 'data_id', 'admitted'];
const ADMISSION_KEYS = ['root', 'id', 'device', 'inode', 'admitted_at', 'operation_id'];
const WORKSPACE_ID = /^ws_[a-f0-9]{24}$/u;
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const fail = (code = 'nnd_workspace_admission_invalid', message = 'Native workspace admission could not be verified.') =>
  new ContractError(code, message);
const conflict = message => fail('nnd_workspace_admission_root_conflict', message);
const identityMismatch = () => fail('nnd_workspace_admission_identity_mismatch',
  'A stored workspace admission no longer verifies against the disk.');
const missingTarget = () => fail('nnd_workspace_admission_target_missing', 'The workspace root is not admitted.');
const grantDocumentError = () => fail('nnd_workspace_grant_identity_mismatch',
  'The workspace grant document does not match the native store identity.');
const storeError = () => fail('nnd_workspace_admission_invalid', 'The workspace admission store is unreadable.');
const SECONDARY_CLEAR = () => fail('nnd_workspace_admission_secondary_clear',
  'The workspace root is anchored by the workspace grant surface; clear the granted secondary there.');

function exact(value, keys) { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function authorize(principal, permission) {
  if (typeof principal?.subjectId !== 'string' || !principal.subjectId.trim() || principal.subjectId.length > 256
    || !Array.isArray(principal.permissions)) throw fail();
  requireIntegrationPermission(principal, permission);
}
/** Receipt-discovery hash: bound to the acting subject AND the channel
 * identity, so operation lookups stay subject-scoped like the settings
 * families (another valid principal cannot enumerate a store it did not
 * write). The human operation_id stays free-form for UI surfacing. */
function operationKey(principal, identity, id) {
  const channel = createHash('sha256').update(JSON.stringify({ ...identity, actor: principal.subjectId })).digest('hex').slice(0, 24);
  return `nndwsadm_${channel}_${createHash('sha256').update(id).digest('hex').slice(0, 24)}`;
}

/** Transport bound only: the exact grammar canonicalGrant re-proves against
 * the disk, applied up front so a malformed path never reaches the store. */
function boundedRoot(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > ROOT_MAX || Buffer.byteLength(value) > ROOT_BYTES
    || !isAbsolute(value) || /[\u0000-\u001f\u007f]/u.test(value) || value.startsWith('\\\\') || value.startsWith('\\?\\')) throw fail();
  return value;
}

/** The persisted row shape a mutation rebuilds from, asserted on every read
 * and on the fresh revoke target. */
function assertAdmittedRowShape(value) {
  if (!record(value) || !exact(value, ADMISSION_KEYS) || typeof value.root !== 'string' || typeof value.id !== 'string'
    || !WORKSPACE_ID.test(value.id) || typeof value.device !== 'string' || !/^\d+$/u.test(value.device)
    || typeof value.inode !== 'string' || !/^\d+$/u.test(value.inode)
    || typeof value.admitted_at !== 'string' || !Number.isFinite(Date.parse(value.admitted_at))
    || !ID.test(value.operation_id ?? '')) throw storeError();
}
const persistedRow = row => ({ root: row.root, id: row.id, device: row.device, inode: row.inode,
  admitted_at: row.admitted_at, operation_id: row.operation_id });

/** Receipt of a published store mutation. `application` stays 'not_applied':
 * admission is a GUI-scoped projection the runtime consumes by reading the
 * store, not by executing anything. */
function receipt(value, identity, id) {
  return Object.freeze({ ...identity, operation_id: id, persistence: value.persistence,
    before_revision: value.beforeRevision, persisted_revision: value.persistedRevision,
    replayed: value.replayed, replay_window: value.replayWindow, application: 'not_applied' });
}

/** The manifest layer masks in-transaction judgment failures behind
 * manifest_validation_failed; this guard re-raises the surface's own typed
 * error afterwards so callers see the real contract code. */
function failureRef() {
  let captured = null;
  return {
    capture: error => { if (error instanceof ContractError) captured = error; throw error; },
    rethrow: error => { if (error?.code === 'manifest_validation_failed' && captured) throw captured; throw error; } };
}

/** The attached root is synthesized fresh on every call. Its identity is the
 * VERBATIM configured root hash (primaryWorkspaceId ≡ the grant surface's
 * primary row ≡ nativeNndPrincipal's session id), while root/device/inode
 * come from the kernel's canonical walk. Newly admitted rows instead carry
 * the canonical kernel id (workspaceId over the realpath) — the same split
 * the grant document itself uses for primary vs secondary rows. */
async function attachedRoot(paths) {
  const configuredRoot = (await readNndConfigurationSources(paths)).config.workspaceRoot;
  return Object.freeze({ ...await readCanonicalGrant(configuredRoot), id: primaryWorkspaceId(configuredRoot) });
}

/** The granted secondary root, re-verified with the kernel on every read so a
 * vanished or drifted grant never yields an empty-looking projection. The
 * grant document's PRIMARY row is not re-probed here: the grant surface owns
 * that judgment, and base GET already serves it. */
async function readSecondaryGrant(ctx, attached) {
  const snapshot = await readManifestSnapshot(ctx.grantPath);
  if (snapshot.state === 'missing') return null;
  const document = snapshot.rawManifest;
  await validatePrimary(document, ctx.identity, attached);
  const secondary = document.secondary;
  if (secondary === null) return null;
  if (!record(secondary) || !exact(secondary, GRANT_KEYS) || !WORKSPACE_ID.test(secondary.id ?? '')) throw grantDocumentError();
  const actual = await readCanonicalGrant(secondary.root);
  if (secondary.id !== actual.id || same(secondary.root, attached.root) || actual.id === attached.id
    || ['root', 'device', 'inode'].some(key => secondary[key] !== actual[key])) throw grantDocumentError();
  return Object.freeze({ root: actual.root, id: actual.id });
}

async function verifyAdmissionRow(value, attached, admitted) {
  assertAdmittedRowShape(value);
  if (same(value.root, attached.root) || value.id === workspaceId(attached.root)) {
    throw fail('nnd_workspace_admission_invalid', 'A stored admission copies the attached workspace root.');
  }
  if (admitted.some(row => row.id === value.id || same(row.root, value.root))) {
    throw fail('nnd_workspace_admission_invalid', 'Two stored admissions claim the same workspace root.');
  }
  let actual;
  try { actual = await readCanonicalGrant(value.root); }
  catch { throw identityMismatch(); }
  if (actual.id !== value.id || ['root', 'device', 'inode'].some(key => actual[key] !== value[key])) throw identityMismatch();
  return Object.freeze({ ...persistedRow(value), ...actual });
}

async function verifyStoreDocument(document, ctx) {
  if (!record(document) || !exact(document, DOCUMENT_KEYS) || document.protocol !== '1.0'
    || document.installation_id !== ctx.identity.installation_id || document.data_id !== ctx.identity.data_id
    || !Array.isArray(document.admitted)) throw storeError();
  const attached = await attachedRoot(ctx.paths);
  const admitted = [];
  for (const value of document.admitted) admitted.push(await verifyAdmissionRow(value, attached, admitted));
  return { attached, secondary: await readSecondaryGrant(ctx, attached), admitted };
}

/** Path-first resolution: a stored row matches by raw path (the honest revoke
 * of a since-removed directory), otherwise the canonical probe of the
 * OPERATOR'S input maps an equivalent spelling onto the row by canonical
 * ws_ id. Stored rows are never probed in this phase. */
function resolveTarget(admitted, root, canonical) {
  const byPath = admitted.find(row => same(row.root, root));
  if (byPath) return byPath;
  if (!canonical) return null;
  return admitted.find(row => row.id === canonical.id) ?? null;
}

/** Shared secondary-clear refusal: revoking a row the grant surface also
 * anchors (by id or raw path) redirects the operator to the grant surface. */
function assertSecondaryClear(row, secondary) {
  if (secondary && (row.id === secondary.id || same(row.root, secondary.root))) throw SECONDARY_CLEAR();
}

/** Lenient grant projection for the revoke refusal check: a poisoned or
 * drifted grant file does not block the admission row's own lifecycle here —
 * validate re-enters the full fail-closed walk before anything publishes. */
async function grantedSecondary(ctx) {
  try { return await readSecondaryGrant(ctx, await attachedRoot(ctx.paths)); }
  catch { return null; }
}

/** Admission input grammar shared by admit and revoke: exact five keys, the
 * channel identity, a revision value, an operation id, and a transport-bounded
 * root. Returns the bounded root. */
function admissionInput(input, identity) {
  if (!record(input) || !exact(input, ['installation_id', 'data_id', 'expected_revision', 'operation_id', 'root'])
    || input.installation_id !== identity.installation_id || input.data_id !== identity.data_id
    || !REVISION.test(input.expected_revision ?? '') || !ID.test(input.operation_id ?? '')) throw fail();
  return boundedRoot(input.root);
}

/** The verified projection of the channel state; an absent store is the
 * attached configuration plus whatever the grant surface projects. */
async function readChannelState(ctx) {
  const snapshot = await readManifestSnapshot(ctx.path);
  if (snapshot.state !== 'missing') {
    return { snapshot, ...await verifyStoreDocument(snapshot.rawManifest, ctx) };
  }
  const attached = await attachedRoot(ctx.paths);
  return { snapshot, attached, secondary: await readSecondaryGrant(ctx, attached), admitted: [] };
}

/** Lean, probe-free store read for revoke resolution. Deliberately weaker
 * than readChannelState so a vanished or drifted WORKSPACE never wedges the
 * operator's only recovery affordance: rows are shape-checked, not disk
 * re-verified here — validate re-runs the full walk before publishing. */
async function readLeanState(ctx) {
  const snapshot = await readManifestSnapshot(ctx.path);
  if (snapshot.state === 'missing') throw missingTarget();
  const document = snapshot.rawManifest;
  if (!record(document) || !exact(document, DOCUMENT_KEYS) || document.protocol !== '1.0'
    || document.installation_id !== ctx.identity.installation_id || document.data_id !== ctx.identity.data_id
    || !Array.isArray(document.admitted)) throw storeError();
  document.admitted.forEach(assertAdmittedRowShape);
  return { revision: snapshot.revision, admitted: document.admitted };
}

async function inventory(ctx, principal) {
  authorize(principal, 'nnd.workspace.read');
  const current = await readChannelState(ctx);
  return Object.freeze({ ...ctx.identity, revision: current.snapshot.revision, selection_enabled: false,
    attached: current.attached, ...(current.secondary ? { secondary_grant: current.secondary } : {}),
    admitted: current.admitted.map(row => Object.freeze(persistedRow(row))),
    application: 'not_applied' });
}

async function admit(ctx, principal, input) {
  authorize(principal, 'nnd.workspace.manage');
  const root = admissionInput(input, ctx.identity);
  const guard = failureRef();
  let result;
  try {
    result = await transactManifest({
      path: ctx.path,
      expectedRevision: input.expected_revision,
      operationId: operationKey(principal, ctx.identity, input.operation_id),
      payload: { ...ctx.identity, actor: principal.subjectId, request: { root, operation_id: input.operation_id } },
      transform: async () => {
        try {
          const current = await readChannelState(ctx);
          const planned = await readCanonicalGrant(root);
          const id = workspaceId(planned.root);
          if (same(planned.root, current.attached.root) || id === workspaceId(current.attached.root)) {
            throw conflict('The attached workspace root is already anchored by the native configuration.');
          }
          if (current.secondary && (same(planned.root, current.secondary.root) || id === current.secondary.id)) {
            throw conflict('The granted secondary root is already anchored by the workspace grant surface.');
          }
          if (current.admitted.some(row => row.id === id || same(row.root, planned.root))) {
            throw conflict('The workspace root is already admitted.');
          }
          return { protocol: '1.0', ...ctx.identity,
            admitted: [...current.admitted.map(persistedRow), { root: planned.root, id, device: planned.device,
              inode: planned.inode, admitted_at: new Date().toISOString(), operation_id: input.operation_id }] };
        } catch (error) { guard.capture(error); }
      },
      validate: async next => { try { await verifyStoreDocument(next, ctx); } catch (error) { guard.capture(error); } } });
  } catch (error) { guard.rethrow(error); }
  return receipt(result, ctx.identity, input.operation_id);
}

async function revoke(ctx, principal, input) {
  authorize(principal, 'nnd.workspace.manage');
  const root = admissionInput(input, ctx.identity);
  const guard = failureRef();
  let result;
  try {
    result = await transactManifest({
      path: ctx.path,
      expectedRevision: input.expected_revision,
      operationId: operationKey(principal, ctx.identity, input.operation_id),
      payload: { ...ctx.identity, actor: principal.subjectId, request: { root, operation_id: input.operation_id } },
      transform: async () => {
        try {
          const fresh = await readLeanState(ctx);
          const live = resolveTarget(fresh.admitted, root, await readCanonicalGrant(root).catch(() => null));
          if (!live) throw missingTarget();
          assertAdmittedRowShape(live);
          assertSecondaryClear(live, await grantedSecondary(ctx));
          return { protocol: '1.0', ...ctx.identity,
            admitted: fresh.admitted.filter(row => !same(row.root, live.root)).map(persistedRow) };
        } catch (error) { guard.capture(error); }
      },
      validate: async next => { try { await verifyStoreDocument(next, ctx); } catch (error) { guard.capture(error); } } });
  } catch (error) { guard.rethrow(error); }
  // The request root is stable across a lost-acknowledgement replay. The row
  // has already been removed when the manifest layer returns its saved receipt.
  return Object.freeze({ ...receipt(result, ctx.identity, input.operation_id), revoked_root: root });
}

async function operation(ctx, principal, id) {
  authorize(principal, 'nnd.workspace.read');
  if (!ID.test(id ?? '')) throw fail();
  const result = await readManifestOperation(ctx.path, operationKey(principal, ctx.identity, id));
  return result ? receipt(result, ctx.identity, id) : null;
}

/** One factory per native settings family, bound to the pair identity. The
 * service exposes four operations over one store file and never the grant
 * file; every function above is module-level so each stays inside the
 * function-length gate, exactly like the grant surface. */
export function createNndWorkspaceAdmissionService({ paths, installationId, dataId }) {
  if (!isAbsolute(paths?.config ?? '') || !ID.test(installationId ?? '') || !ID.test(dataId ?? '')) throw fail();
  const ctx = Object.freeze({ paths,
    identity: Object.freeze({ installation_id: installationId, data_id: dataId }),
    path: join(paths.config, 'nnd-workspace-admissions.json'),
    grantPath: join(paths.config, 'nnd-workspace-grants.json') });
  return Object.freeze({ inventory: principal => inventory(ctx, principal),
    admit: (principal, input) => admit(ctx, principal, input),
    revoke: (principal, input) => revoke(ctx, principal, input),
    operation: (principal, id) => operation(ctx, principal, id) });
}
