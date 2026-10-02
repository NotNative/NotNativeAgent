// SPDX-License-Identifier: Apache-2.0
import { lstat, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { resolveManifest } from './config.js';
import { NND_CONFIGURATION_OPTIONS } from './nnd-setup-config.js';
import { validCatalogRecord } from './nnd-session-helpers.js';
import { validSnapshot } from './nnd-child-snapshot.js';
import { nativeNndPrincipal } from './nnd-service-native.js';
import { recoverJournal } from './store.js';
import { assertResumeProvenance } from './persistence/session-provenance.js';
import { validateMigrationActivity } from './nnd-migration-activity.js';
import { boundedMigrationRead as read, digest, migrationError, parseMigrationJson } from './nnd-migration-files.js';

const MAX = 64 * 1024 * 1024;
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
async function sameWorkspace(path, expected) {
  if (typeof path !== 'string' || (await realpath(path)).toLowerCase() !== expected) throw migrationError();
}
export async function readMigrationParents(paths) {
  const bytes = await read(paths.root, join(paths.sessions, 'nnd-contexts.json'), 1048576);
  const records = parseMigrationJson(bytes);
  if (!Array.isArray(records) || records.length > 64 || records.some((item) => !validCatalogRecord(item) || item.sessionId.includes(':'))
    || new Set(records.map((item) => item.sessionId)).size !== records.length) throw migrationError();
  return { bytes, records };
}
export async function prepareNndMigration(paths, parents, signal) {
  const manifest = await read(paths.root, join(paths.config, 'manifest.json'), 1048576);
  const document = parseMigrationJson(manifest);
  if (typeof document.workspace_root !== 'string' || !isAbsolute(document.workspace_root)
    || document.workspace_root.length > 4096 || /[\u0000-\u001f\u007f]/u.test(document.workspace_root)) throw migrationError();
  const config = resolveManifest(document, NND_CONFIGURATION_OPTIONS);
  const workspace = (await realpath(config.workspaceRoot)).toLowerCase();
  const workspaceIds = nativeNndPrincipal(config.workspaceRoot).workspaceIds;
  const evidence = [{ path: 'config/manifest.json', hash: digest(manifest), limit: 1048576 }];
  let journalBytes = 0;
  for (const parent of parents.records) {
    signal.throwIfAborted();
    if (parent.subjectId !== 'nnd-local-operator' || parent.workspaceIds.length !== 1 || parent.workspaceIds[0] !== 'local') throw migrationError();
    await sameWorkspace(parent.directory, workspace);
    journalBytes += await validateJournal(paths, parent.sessionId, config, workspace, evidence);
    if (journalBytes > MAX) throw migrationError();
  }
  const files = [{ path: 'sessions/nnd-contexts.json', before: parents.bytes,
    after: json(parents.records.map((parent) => ({ ...parent, workspaceIds }))) }];
  await collectChildren(paths, parents.records, workspace, workspaceIds, files, signal);
  const activityBytes = await validateMigrationActivity(paths, parents.records, evidence, signal);
  const stagedBytes = files.reduce((size, file) => size + file.before.length + file.after.length, 0);
  if (journalBytes + stagedBytes + activityBytes > MAX) throw migrationError();
  return { files, evidence, workspace_id: workspaceIds[0], sessions: parents.records.map((parent) => parent.sessionId) };
}
async function validateJournal(paths, id, config, workspace, evidence) {
  const relative = `sessions/${id}.journal.ndjson`; const path = join(paths.root, relative);
  const bytes = await read(paths.root, path, 16 * 1024 * 1024);
  if (!bytes.length || bytes.at(-1) !== 10) throw migrationError();
  const recovered = await recoverJournal(path, { maxBytes: 16 * 1024 * 1024 });
  const created = recovered.records.filter((record) => record.type === 'session_created');
  if (recovered.corruptTail || recovered.truncated || created.length !== 1
    || recovered.records[0] !== created[0] || created[0].payload.sessionId !== id) throw migrationError();
  await sameWorkspace(created[0].payload.workspaceRoot, workspace);
  const changed = recovered.records.filter((record) => record.type === 'workspace_changed').at(-1);
  if (changed) await sameWorkspace(changed.payload.workspaceRoot, workspace);
  assertResumeProvenance([created[0]], config.executionManifest, config.mission);
  if (created[0].payload.executionManifest?.workspaceRoot) await sameWorkspace(created[0].payload.executionManifest.workspaceRoot, workspace);
  if (digest(await read(paths.root, path, bytes.length)) !== digest(bytes)) throw migrationError();
  evidence.push({ path: relative, hash: digest(bytes), limit: 16 * 1024 * 1024 });
  return bytes.length;
}
async function collectChildren(paths, parents, workspace, workspaceIds, files, signal) {
  const path = join(paths.sessions, 'nnd-contexts.json.children');
  let info;
  try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink()) throw migrationError();
  let count = 0, bytesTotal = 0;
  for await (const entry of await opendir(path)) {
    signal.throwIfAborted(); if (++count > 256 || !entry.isFile() || !/^(?:[a-f0-9]{2})+\.json$/u.test(entry.name)) throw migrationError();
    const bytes = await read(paths.root, join(path, entry.name), 2097152);
    bytesTotal += bytes.length; if (bytesTotal > MAX / 2) throw migrationError();
    const child = parseMigrationJson(bytes); const parent = parents.find((item) => item.sessionId === child.parentId);
    if (!validSnapshot(child) || !parent || child.subjectId !== parent.subjectId || child.parentCreatedAt !== parent.createdAt
      || child.workspaceIds.length !== 1 || child.workspaceIds[0] !== 'local'
      || `${Buffer.from(child.sessionId).toString('hex')}.json` !== entry.name) throw migrationError();
    await sameWorkspace(child.directory, workspace);
    files.push({ path: `sessions/nnd-contexts.json.children/${entry.name}`, before: bytes, after: json({ ...child, workspaceIds }) });
  }
}
