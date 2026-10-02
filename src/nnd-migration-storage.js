// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, opendir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ensurePrivateNndRuntimeDirectory } from './nnd-service-private-storage.js';
import { exactRecord } from './nnd-service-contract.js';
import { requireExternalId } from './ids.js';
import { boundedMigrationRead as read, digest, migrationError, parseMigrationJson, writeMigrationNew,
  replaceMigrationBytes, removeMigrationOwned } from './nnd-migration-files.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const TARGET = /^(?:sessions\/nnd-contexts\.json(?:\.children\/(?:[a-f0-9]{2})+\.json)?|runtime\/nnd\/admission\.json)$/u;
const json = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
export async function assertNoNndMigration(identity) {
  try { await lstat(join(identity.data_root, 'runtime', 'nnd', 'migration-pending.json')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw migrationError();
}
export async function stageNndMigration(identity, plan, census) {
  const { path } = await ensurePrivateNndRuntimeDirectory(identity.data_root);
  const root = join(path, 'migrations'); await mkdir(root, { recursive: true });
  let count = 0; for await (const _entry of await opendir(root)) if (++count >= 16) throw migrationError();
  const id = randomUUID(), directory = join(root, id); await mkdir(directory);
  const admissionPath = 'runtime/nnd/admission.json';
  if (await read(identity.data_root, join(identity.data_root, admissionPath), 2048, true)) throw migrationError();
  const admission = { version: '2.0', data_id: identity.data_id, installation_id: identity.installation_id,
    basis: 'legacy_catalog_migration', census };
  const sources = [...plan.files, { path: admissionPath, before: null, after: json(admission) }];
  const files = [];
  for (const [index, file] of sources.entries()) {
    if (file.before) await writeMigrationNew(join(directory, `${index}.before`), file.before);
    await writeMigrationNew(join(directory, `${index}.after`), file.after);
    files.push({ path: file.path, before: file.before ? digest(file.before) : null, after: digest(file.after),
      before_bytes: file.before?.length ?? 0, after_bytes: file.after.length });
  }
  const record = { version: '1.0', id, installation_id: identity.installation_id, data_id: identity.data_id,
    workspace_id: plan.workspace_id, sessions: plan.sessions, files, evidence: plan.evidence };
  const bytes = json(record); await writeMigrationNew(join(directory, 'transaction.json'), bytes);
  const pending = json({ version: '1.0', transaction_id: id });
  await writeMigrationNew(join(path, 'migration-pending.json'), pending);
  return { record, bytes, directory, pending, pendingPath: join(path, 'migration-pending.json') };
}
export async function loadNndMigration(identity) {
  const { path } = await ensurePrivateNndRuntimeDirectory(identity.data_root);
  const pendingPath = join(path, 'migration-pending.json');
  const pending = await read(identity.data_root, pendingPath, 1024);
  const pointer = parseMigrationJson(pending);
  if (!exactRecord(pointer, ['version', 'transaction_id']) || pointer.version !== '1.0' || !UUID.test(pointer.transaction_id)) throw migrationError();
  const directory = join(path, 'migrations', pointer.transaction_id);
  const bytes = await read(identity.data_root, join(directory, 'transaction.json'), 131072);
  const record = parseMigrationJson(bytes); validateRecord(record, identity, pointer.transaction_id);
  await validateBackupOwnership(identity, directory, record);
  return { record, bytes, directory, pending, pendingPath };
}
function validateRecord(record, identity, id) {
  if (!exactRecord(record, ['version', 'id', 'installation_id', 'data_id', 'workspace_id', 'sessions', 'files', 'evidence'])
    || record.version !== '1.0' || record.id !== id || record.installation_id !== identity.installation_id || record.data_id !== identity.data_id
    || !/^ws_[a-f0-9]{24}$/u.test(record.workspace_id) || !Array.isArray(record.sessions) || record.sessions.length > 64
    || new Set(record.sessions).size !== record.sessions.length || !Array.isArray(record.files) || record.files.length < 2 || record.files.length > 258
    || new Set(record.files.map((file) => file?.path)).size !== record.files.length || !Array.isArray(record.evidence) || record.evidence.length > 129) throw migrationError();
  for (const id of record.sessions) { requireExternalId(id, 'session_id'); if (id.includes(':')) throw migrationError(); }
  for (const file of record.files) {
    if (!exactRecord(file, ['path', 'before', 'after', 'before_bytes', 'after_bytes']) || typeof file.path !== 'string' || !TARGET.test(file.path)
      || !(file.before === null || typeof file.before === 'string' && HASH.test(file.before)) || typeof file.after !== 'string' || !HASH.test(file.after)
      || !Number.isSafeInteger(file.before_bytes) || file.before_bytes < 0 || file.before_bytes > 2097152
      || !Number.isSafeInteger(file.after_bytes) || file.after_bytes < 1 || file.after_bytes > 2097152
      || (file.before === null) !== (file.path === 'runtime/nnd/admission.json') || (file.before === null) !== (file.before_bytes === 0)) throw migrationError();
  }
  if (record.files.reduce((sum, file) => sum + file.before_bytes + file.after_bytes, 0) > 67108864) throw migrationError();
  if (!record.files.some((file) => file.path === 'sessions/nnd-contexts.json')
    || !record.files.some((file) => file.path === 'runtime/nnd/admission.json')) throw migrationError();
  const evidencePaths = new Set(record.evidence.map((item) => item?.path));
  if (evidencePaths.size !== record.evidence.length || !evidencePaths.has('config/manifest.json')
    || record.sessions.some((id) => !evidencePaths.has(`sessions/${id}.journal.ndjson`))) throw migrationError();
}
async function validateBackupOwnership(identity, directory, record) {
  let parents;
  for (const [index, file] of record.files.entries()) {
    if (file.before === null) continue;
    const before = await read(identity.data_root, join(directory, `${index}.before`), file.before_bytes);
    const after = await read(identity.data_root, join(directory, `${index}.after`), file.after_bytes);
    if (before.length !== file.before_bytes || after.length !== file.after_bytes
      || digest(before) !== file.before || digest(after) !== file.after) throw migrationError();
    const original = parseMigrationJson(before), replacement = parseMigrationJson(after);
    if (file.path === 'sessions/nnd-contexts.json') {
      if (!Array.isArray(original) || !Array.isArray(replacement)
        || !isDeepStrictEqual(original.map((item) => item.sessionId).sort(), [...record.sessions].sort())) throw migrationError();
      parents = original;
      if (!isDeepStrictEqual(original.map((item) => rewriteScope(item, record.workspace_id)), replacement)) throw migrationError();
    } else if (!isDeepStrictEqual(rewriteScope(original, record.workspace_id), replacement)) throw migrationError();
  }
  if (!parents) throw migrationError();
}
function rewriteScope(value, workspaceId) {
  if (!value || value.subjectId !== 'nnd-local-operator' || !isDeepStrictEqual(value.workspaceIds, ['local'])) throw migrationError();
  return { ...value, workspaceIds: [workspaceId] };
}
export async function verifyMigrationEvidence(identity, transaction) {
  for (const item of transaction.record.evidence) {
    if (!exactRecord(item, ['path', 'hash', 'limit']) || !/^(?:config\/manifest\.json|sessions\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.journal\.ndjson|sessions\/nnd-contexts\.json\.activity\/(?:[a-f0-9]{2})+\.json)$/u.test(item.path)
      || !HASH.test(item.hash) || !Number.isSafeInteger(item.limit) || item.limit < 1 || item.limit > 16777216) throw migrationError();
    if (digest(await read(identity.data_root, join(identity.data_root, item.path), item.limit)) !== item.hash) throw migrationError();
  }
}
export async function applyNndMigration(identity, transaction, signal, checkpoint = async () => {}) {
  await verifyMigrationEvidence(identity, transaction);
  for (const [index, file] of transaction.record.files.entries()) {
    signal.throwIfAborted();
    await replaceFile(identity, transaction, file, index, 'after');
    await checkpoint(`replaced:${index}`);
  }
  signal.throwIfAborted(); await verifyMigrationEvidence(identity, transaction);
  await writeMigrationNew(join(transaction.directory, 'completed.json'), json({ id: transaction.record.id, hash: digest(transaction.bytes) }));
  await checkpoint('committed');
  await removeMigrationOwned(transaction.pendingPath, transaction.pending, identity.data_root);
}
async function replaceFile(identity, transaction, file, index, direction) {
  const path = join(identity.data_root, file.path);
  const current = await read(identity.data_root, path, 2097152, true);
  const hash = current ? digest(current) : null;
  if (hash !== file.before && hash !== file.after) throw migrationError();
  if (hash === file[direction]) return;
  if (file[direction] === null) { await unlink(path); return; }
  const backup = await read(identity.data_root, join(transaction.directory, `${index}.${direction}`), 2097152);
  if (digest(backup) !== file[direction]) throw migrationError();
  await replaceMigrationBytes(path, backup, randomUUID());
}
export async function recoverNndMigration(identity, transaction, signal) {
  const completed = await read(identity.data_root, join(transaction.directory, 'completed.json'), 1024, true);
  if (completed) {
    // Security: a TUI can resume after the migration process dies; completion cannot certify changed journal or configuration provenance.
    await verifyMigrationEvidence(identity, transaction);
    const record = parseMigrationJson(completed);
    if (!exactRecord(record, ['id', 'hash']) || record.id !== transaction.record.id || record.hash !== digest(transaction.bytes)) throw migrationError();
    for (const file of transaction.record.files) {
      signal.throwIfAborted();
      if (digest(await read(identity.data_root, join(identity.data_root, file.path), 2097152)) !== file.after) throw migrationError();
    }
  } else {
    for (const [index, file] of transaction.record.files.entries()) {
      signal.throwIfAborted(); await replaceFile(identity, transaction, file, index, 'before');
    }
  }
  await removeMigrationOwned(transaction.pendingPath, transaction.pending, identity.data_root);
  return completed ? 'committed' : 'rolled_back';
}
