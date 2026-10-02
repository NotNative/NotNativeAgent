// SPDX-License-Identifier: Apache-2.0
import { DatabaseSync } from 'node:sqlite';
import { lstat, opendir } from 'node:fs/promises';
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
export async function hasActivationEvidence(dataRoot) {
  const directory = join(dataRoot, 'runtime', 'nnd', 'install-slots', 'activations');
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
