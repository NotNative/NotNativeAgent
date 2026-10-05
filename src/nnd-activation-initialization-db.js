// SPDX-License-Identifier: Apache-2.0
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { lstat, opendir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ContractError } from './ids.js';
import { noLinks } from './nnd-payload-contract-files.js';

const SCHEMA = 'CREATE TABLE activation_preparation (id INTEGER PRIMARY KEY CHECK(id=1), intent TEXT NOT NULL)';
const LIMIT = 64 * 1024;
const invalid = () => new ContractError('nnd_activation_preparation_invalid',
  'Native activation preparation evidence is incomplete or inconsistent; preserve the admission barrier.');
const databasePath = root => join(root, 'activation-preparation.sqlite');
async function regular(path, optional = false) {
  let info;
  try { info = await lstat(path); }
  catch (error) { if (optional && error.code === 'ENOENT') return false; throw invalid(); }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024) throw invalid();
  try { await noLinks(path); } catch { throw invalid(); }
  return true;
}
async function openDatabase(root, writable) {
  const path = databasePath(root);
  if (!await regular(path, true) && !writable) return null;
  for (const suffix of ['-journal', '-wal', '-shm']) await regular(path + suffix, true);
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: !writable });
    db.exec('PRAGMA busy_timeout=0;');
    const schema = db.prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 2").all();
    if (schema.length > 1 || schema.length === 1
      && (schema[0].name !== 'activation_preparation' || schema[0].sql !== SCHEMA)) throw invalid();
    if (!schema.length) {
      if (!writable) { db.close(); return null; }
      db.exec(SCHEMA);
    }
    if (writable) db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA max_page_count=256;');
    return db;
  } catch { db?.close(); throw invalid(); }
}
function row(db) {
  const entries = db.prepare('SELECT id, length(CAST(intent AS BLOB)) AS bytes FROM activation_preparation LIMIT 2').all();
  if (!entries.length) return null;
  if (entries.length !== 1 || entries[0].id !== 1 || entries[0].bytes > LIMIT) throw invalid();
  return db.prepare('SELECT intent FROM activation_preparation WHERE id=1').get().intent;
}
export async function hasActivationInitialization(dataRoot) {
  const db = await openDatabase(join(dataRoot, 'runtime', 'nnd', 'install-slots'), false);
  if (!db) return false;
  try { return row(db) !== null; } finally { db.close(); }
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SHA = /^[a-f0-9]{64}$/u;
async function readPairBytes(path) {
  const bytes = await readFile(path);
  if (bytes.length > 4096) throw invalid();
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw invalid(); }
  return { bytes, value };
}
/** ADR 0065/0066 receipt test: canonical, mutually bound, and bound to this identity. */
export async function consumedRetirementPair(root, identity) {
  if (!identity) return null;
  try {
    const commit = await readPairBytes(join(root, 'activation-retirement-commit.json'));
    const witness = await readPairBytes(join(root, 'activation-retirement-cleared.json'));
    const terminalKeys = ['protocol', 'state', 'operation_id', 'stage_operation_id', 'installation_id',
      'data_id', 'generation', 'plan_sha256', 'decision_sha256', 'completion_sha256',
      'marker_sha256', 'registration_revision', 'discovery_sha256', 'child_process_identity'];
    const t = commit.value, w = witness.value;
    const keySet = (o, extra = 0) => o && typeof o === 'object' && !Array.isArray(o)
      && Object.keys(o).length === terminalKeys.length + extra;
    // Every field mirrors except `state`, which intentionally differs and is
    // validated per-file above (ADR 0064/0065 canonical shapes).
    const mirror = terminalKeys.filter(key => key !== 'state').every(key =>
      t?.[key] !== undefined && Object.hasOwn(w, key)
      && Buffer.from(JSON.stringify(w[key])).equals(Buffer.from(JSON.stringify(t[key]))));
    const canonical = (bytes, value) => Buffer.from(JSON.stringify(value) + '\n').equals(bytes);
    if (!keySet(t) || !keySet(w, 1) || !canonical(commit.bytes, t) || !canonical(witness.bytes, w)) return false;
    if (t.protocol !== '1.0' || t.state !== 'terminal_committed_barred'
      || w.state !== 'barriers_cleared_admission_barred'
      || !UUID.test(t.operation_id) || !UUID.test(t.stage_operation_id) || t.operation_id === t.stage_operation_id
      || !UUID.test(t.generation) || !SHA.test(t.plan_sha256) || !SHA.test(t.decision_sha256)
      || !SHA.test(t.completion_sha256) || !SHA.test(t.marker_sha256) || !SHA.test(t.registration_revision)
      || !SHA.test(t.discovery_sha256)) return false;
    if (identity.installation_id && (t.installation_id !== identity.installation_id
      || w.installation_id !== identity.installation_id)) return null;
    if (identity.data_id && (t.data_id !== identity.data_id || w.data_id !== identity.data_id)) return null;
    if (!(mirror && createHash('sha256').update(commit.bytes).digest('hex') === w.terminal_sha256
      && w.protocol === '1.0')) return null;
    return Object.freeze({ commit_sha256: createHash('sha256').update(commit.bytes).digest('hex'),
      operation_id: t.operation_id, registration_revision: t.registration_revision });
  } catch { return null; }
}
export async function hasActivationEvidence(dataRoot, identity = null) {
  const root = join(dataRoot, 'runtime', 'nnd', 'install-slots');
  // External retirement evidence keeps ordinary admission barred even after
  // the journal, earlier proofs, and marker have been retired.
  const cleared = await regular(join(root, 'activation-retirement-cleared.json'), true);
  const committed = await regular(join(root, 'activation-retirement-commit.json'), true);
  if (cleared && committed && await consumedRetirementPair(root, identity)) {
    // ADR 0065/0066: the terminal commit and cleared witness are durable by
    // design, but ADR 0065 reserves this exact transition — once the live
    // admission gate and public controller have reconciled, ordinary startup
    // may treat the canonical pair as an admission receipt. The pair must be
    // byte-canonical, mirror each other field for field, and the witness must
    // hash-bind the commit bytes. Either file alone, or any alteration,
    // keeps the bar exactly as ADR 0065 demands.
  } else if (cleared || committed) return true;
  if (await regular(join(root, 'activation-retirement-decision.json'), true)
    || await regular(join(root, 'activation-retirement.json'), true)) return true;
  const directory = join(root, 'activations');
  try { await lstat(directory); } catch (error) { if (error.code === 'ENOENT') return false; throw invalid(); }
  try {
    await noLinks(directory);
    for await (const _entry of await opendir(directory)) return true;
    return false;
  } catch { throw invalid(); }
}
export async function withActivationInitialization(storeRoot, operation) {
  const db = await openDatabase(storeRoot, true);
  try {
    return await operation({ read: () => row(db),
      write: bytes => {
        if (typeof bytes !== 'string' || Buffer.byteLength(bytes) > LIMIT || row(db) !== null) throw invalid();
        db.prepare('INSERT INTO activation_preparation(id,intent) VALUES(1,?)').run(bytes);
      },
      clear: bytes => {
        if (row(db) !== bytes) throw invalid();
        db.prepare('DELETE FROM activation_preparation WHERE id=1 AND intent=?').run(bytes);
      } });
  } finally { db.close(); }
}
