// SPDX-License-Identifier: Apache-2.0
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { assertManifestLease, withManifestLock, runManifestLeaseWork } from './manifest-lock.js';
import { digest, MANIFEST_LIMIT, manifestFailure, manifestTarget, readTargetSnapshot,
  stageManifest, publishManifest, removeManifest, writePrivateFile, serializeManifestBytes } from './manifest-files.js';
import { openManifestReceipts, reconcileManifestReceipts, manifestReceipt, prepareManifestReceipt,
  finishManifestReceipt, receiptOutcome, reserveManifestReceipt } from './manifest-receipts.js';

const MUTATING = new WeakSet();
export { withManifestLock } from './manifest-lock.js';
export async function readManifestSnapshot(path, options = {}) {
  return readTargetSnapshot(await manifestTarget(path, {...options, prepareStorage:false}));
}
export async function readLockedManifestSnapshot(lease) {
  return exclusiveLeaseWork(lease, async () => {
    const target = assertManifestLease(lease);
    const database = await openManifestReceipts(lease);
    try { await reconcileManifestReceipts(lease, database); return await readTargetSnapshot(target); }
    finally { database.close(); }
  });
}
async function exclusiveLeaseWork(lease, operation) {
  assertManifestLease(lease);
  if (MUTATING.has(lease)) throw manifestFailure('manifest_lock_busy');
  MUTATING.add(lease);
  try { return await runManifestLeaseWork(lease,operation); } finally { MUTATING.delete(lease); }
}
function serializedRequest(input) {
  if (!Object.hasOwn(input, 'expectedRevision') || typeof input.expectedRevision !== 'string' || !/^(absent|[a-f0-9]{64})$/u.test(input.expectedRevision)
    || typeof input.operationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(input.operationId)) throw manifestFailure('manifest_request_invalid');
  let serialized;
  try { serialized = JSON.stringify(input.payload); } catch { throw manifestFailure('manifest_request_invalid'); }
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > MANIFEST_LIMIT) throw manifestFailure('manifest_request_invalid');
  return serialized;
}
function requestIdentity(input) {
  const serialized = serializedRequest(input);
  if (typeof input.transform !== 'function' || typeof input.validate !== 'function') throw manifestFailure('manifest_request_invalid');
  return digest(JSON.stringify({ expectedRevision: input.expectedRevision, payload: serialized }));
}
function rawRequestIdentity(input, bytes) {
  const serialized = serializedRequest(input);
  return digest(JSON.stringify({ kind: 'raw-manifest-v1', expectedRevision: input.expectedRevision,
    payload: serialized, afterRevision: bytes === null ? 'absent' : digest(bytes) }));
}
export async function transactManifest(input) {
  requestIdentity(input);
  return withManifestLock(input.path, { signal: input.signal, timeoutMs: input.timeoutMs }, lease => transactLockedManifest(lease, input));
}
export async function transactLockedManifest(lease, input) {
  return exclusiveLeaseWork(lease,()=>transactOwned(lease,input,requestIdentity(input),
    snapshot => validatedDocument(input,snapshot)));
}
// Invariant: an internal caller may restore the exact prior bytes, including malformed
// documents or absence, only while it holds the target's genuine manifest mutex.
export async function transactLockedManifestBytes(lease, input) {
  if (!(input?.bytes === null || Buffer.isBuffer(input?.bytes)) || input.bytes?.length > MANIFEST_LIMIT) {
    throw manifestFailure('manifest_request_invalid');
  }
  const bytes = input.bytes === null ? null : Buffer.from(input.bytes);
  const payloadHash = rawRequestIdentity(input, bytes);
  // Security: the operation identity must not drift while lease work awaits I/O.
  const request = { path: input.path, expectedRevision: input.expectedRevision,
    operationId: input.operationId, signal: input.signal };
  return exclusiveLeaseWork(lease, () => transactOwned(lease, request, payloadHash, () => bytes));
}
async function transactOwned(lease, input, payloadHash, produceBytes) {
  const target = assertManifestLease(lease);
  const pathKey = value => typeof value === 'string' && process.platform === 'win32' ? value.toLowerCase() : value;
  if (input.path !== undefined && pathKey(input.path) !== pathKey(target.path)) throw manifestFailure('manifest_target_invalid');
  const database = await openManifestReceipts(lease);
  try {
    await reconcileManifestReceipts(lease, database);
    const prior = manifestReceipt(database, input.operationId, payloadHash);
    if (prior) return receiptOutcome(prior, true);
    await reserveManifestReceipt(lease, database);
    return await commit(lease, database, input, payloadHash, produceBytes);
  } finally { database.close(); }
}
async function commit(lease, database, input, payloadHash, produceBytes) {
  const target = assertManifestLease(lease);
  const snapshot = await readTargetSnapshot(target);
  if (snapshot.revision !== input.expectedRevision) throw manifestFailure('manifest_revision_conflict');
  input.signal?.throwIfAborted();
  const bytes = await produceBytes(snapshot);
  const after = bytes === null ? 'absent' : digest(bytes);
  input.signal?.throwIfAborted();
  if (database.prepare('SELECT COUNT(*) AS count FROM operations').get().count >= 128) throw manifestFailure('manifest_receipt_capacity');
  const staged = bytes === null ? null : await stageManifest(target, bytes);
  let prepared = false; let persistence = 'unpublished'; let backup = null;
  try {
    backup = snapshot.rawBytes ? `backup-${randomUUID()}.bin` : null;
    if (backup) await writePrivateFile(join(target.storage, backup), snapshot.rawBytes);
    const current = await readTargetSnapshot(target);
    if (current.revision !== snapshot.revision) throw manifestFailure('manifest_revision_conflict');
    prepareManifestReceipt(database, { id: input.operationId, payloadHash, before: snapshot.revision,
      after, backup, staged: staged === null ? null : basename(staged) });
    prepared = true;
    input.signal?.throwIfAborted();
    if (staged === null) {
      if (snapshot.state !== 'missing') await removeManifest(target);
    } else await publishManifest(target, staged, snapshot.state === 'missing');
    persistence = 'saved';
    finishManifestReceipt(database, input.operationId, 'saved');
    return receiptOutcome(manifestReceipt(database, input.operationId, payloadHash));
  } catch (error) {
    if (!prepared) throw error;
    try {
      await reconcileManifestReceipts(lease, database);
      const result = receiptOutcome(manifestReceipt(database, input.operationId, payloadHash));
      persistence = result.persistence;
      if (result.persistence === 'saved') return result;
      const failure = manifestFailure('manifest_publication_failed'); failure.operationId = input.operationId; throw failure;
    } catch (failure) {
      if (failure.code === 'manifest_publication_failed') throw failure;
      persistence = error.manifestPublished || persistence === 'saved' ? 'saved' : 'unknown';
      const unknown = manifestFailure('manifest_publication_unknown', persistence);
      unknown.operationId = input.operationId; throw unknown;
    }
  } finally {
    if (staged !== null) await cleanupArtifact(staged, persistence);
    if (!prepared && backup) await cleanupArtifact(join(target.storage, backup), persistence);
  }
}
export async function readManifestOperation(path, operationId, options = {}) {
  if (typeof operationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(operationId)) throw manifestFailure('manifest_request_invalid');
  return withManifestLock(path, options, async (lease) => {
    const database = await openManifestReceipts(lease);
    try {
      await reconcileManifestReceipts(lease, database);
      const row = database.prepare('SELECT * FROM operations WHERE id=?').get(operationId);
      return row ? receiptOutcome(row, true) : null;
    } finally { database.close(); }
  });
}

// Recovery callers already own the target mutex. Reacquiring it would deadlock;
// reconcile the durable receipt under that same lease before reporting its state.
export async function readLockedManifestOperation(lease, operationId) {
  if (typeof operationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(operationId)) throw manifestFailure('manifest_request_invalid');
  return exclusiveLeaseWork(lease, async () => {
    const database = await openManifestReceipts(lease);
    try {
      await reconcileManifestReceipts(lease, database);
      const row = database.prepare('SELECT * FROM operations WHERE id=?').get(operationId);
      return row ? receiptOutcome(row, true) : null;
    } finally { database.close(); }
  });
}

async function cleanupArtifact(path, persistence) {
  try { await unlink(path); } catch (error) {
    if (error.code !== 'ENOENT') throw manifestFailure('manifest_cleanup_failed', persistence);
  }
}

async function validatedDocument(input,snapshot) {
  // Security: transforms never receive the cached source object or preserved byte buffer.
  let next;
  try {
    next = await input.transform(structuredClone(snapshot.rawManifest), { state: snapshot.state, revision: snapshot.revision });
    await input.validate(structuredClone(next));
  } catch { throw manifestFailure('manifest_validation_failed'); }
  return serializeManifestBytes(next);
}
