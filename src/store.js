// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ContractError } from './ids.js';

export class JournalStore {
  #handle = null;
  #previousHash = '0'.repeat(64);
  #sequence = 0;
  #tail = Promise.resolve();

  constructor(root, sessionId, options = {}) {
    this.root = root;
    this.sessionId = sessionId;
    this.path = join(root, `${sessionId}.journal.ndjson`);
    this.resumeRecordLimit = options.resumeRecordLimit ?? 10_000;
    this.persistenceDeadlineMs = options.persistenceDeadlineMs ?? 10_000;
    this.openFile = options.openFile ?? open;
    this.persistenceFailed = false;
  }

  async open() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    let recovered = await recoverJournal(this.path, { tailLimit: this.resumeRecordLimit });
    if (recovered.corruptTail && recovered.truncated) recovered = await recoverJournal(this.path);
    if (recovered.legacyFormat) {
      if (recovered.truncated) recovered = await recoverJournal(this.path);
      await migrateLegacyJournal(this.path, recovered.records);
      recovered = await recoverJournal(this.path, { tailLimit: this.resumeRecordLimit });
    }
    if (recovered.corruptTail) {
      const recoveryPath = `${this.path}.verified-prefix.${Date.now()}`;
      const prefix = recovered.records.map((record) => JSON.stringify(record)).join('\n');
      await writeFile(recoveryPath, prefix.length > 0 ? `${prefix}\n` : '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return { ...recovered, recoveryPath };
    }
    this.#sequence = recovered.lastSequence;
    this.#previousHash = recovered.lastHash;
    this.#handle = await this.openFile(this.path, 'a', 0o600);
    const headerRecords = recovered.truncated ? await readJournalPrefix(this.path, 1) : recovered.records.slice(0, 1);
    return { ...recovered, headerRecords };
  }

  async append(type, payload) {
    return this.#enqueue(() => this.#append(type, payload));
  }

  async #append(type, payload) {
    if (!this.#handle) throw new ContractError('store_closed', 'journal is not open');
    if (this.persistenceFailed) throw new ContractError('persistence_unavailable', 'journal persistence is unavailable after a failed flush');
    const base = { format: 1, sequence: this.#sequence + 1, type, payload, previous: this.#previousHash };
    const hash = digest(base);
    const line = `${JSON.stringify({ ...base, hash })}\n`;
    await this.#flush(() => this.#handle.write(line, null, 'utf8'));
    await this.#flush(() => this.#handle.sync());
    this.#sequence += 1;
    this.#previousHash = hash;
    return Object.freeze({ ...base, hash });
  }

  async close() {
    return this.#enqueue(() => this.#close());
  }

  async #close() {
    if (!this.#handle) return;
    if (!this.persistenceFailed) await this.#flush(() => this.#handle.sync());
    await this.#flush(() => this.#handle.close());
    this.#handle = null;
  }

  async replace(records) {
    if (!Array.isArray(records) || records.length > 100_000) {
      throw new ContractError('journal_replace_invalid', 'replacement journal records are invalid');
    }
    return this.#enqueue(() => this.#replace(records));
  }

  async #replace(records) {
    await this.#close();
    const temporary = `${this.path}.replace-${process.pid}`;
    const lines = encodeRecords(records);
    await writeFile(temporary, lines.length ? `${lines.join('\n')}\n` : '', { flag: 'wx', mode: 0o600 });
    await rename(temporary, this.path);
    const recovered = await recoverJournal(this.path, { tailLimit: this.resumeRecordLimit });
    this.#sequence = recovered.lastSequence;
    this.#previousHash = recovered.lastHash;
    this.#handle = await this.openFile(this.path, 'a', 0o600);
  }

  #enqueue(operation) {
    const pending = this.#tail.then(operation);
    this.#tail = pending.catch(() => undefined);
    return pending;
  }

  async #flush(operation) {
    let timer;
    const work = Promise.resolve().then(operation);
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ContractError(
        'persistence_flush_timeout', 'persistence flush exceeded its deadline', true,
      )), this.persistenceDeadlineMs);
    });
    try { return await Promise.race([work, timeout]); }
    catch (error) {
      if (error?.code === 'persistence_flush_timeout') this.persistenceFailed = true;
      throw error;
    } finally { clearTimeout(timer); work.catch(() => undefined); }
  }
}

export async function recoverJournal(path, options = {}) {
  if (options.tailLimit !== undefined) return recoverJournalTail(path, options.tailLimit);
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return emptyRecovery();
    throw error;
  }
  const lines = text.split('\n');
  const records = [];
  let previous = '0'.repeat(64);
  let corruptTail = false;
  let legacyFormat = false;
  for (const line of lines) {
    if (line.length === 0) continue;
    const record = parseRecord(line);
    const format = journalFormat(record);
    if (!record || format === null || record.sequence !== records.length + 1
      || record.previous !== previous || record.hash !== digestWithoutHash(record)) {
      corruptTail = true;
      break;
    }
    legacyFormat ||= format === 0;
    records.push(record);
    previous = record.hash;
  }
  return recoveryResult(records, previous, corruptTail, false, legacyFormat);
}

export async function readJournalPage(path, options = {}) {
  const limit = boundedLimit(options.limit, 200);
  const beforeSequence = options.beforeSequence ?? Number.MAX_SAFE_INTEGER;
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    let bytes = Math.min(size, 64 * 1024);
    while (true) {
      const lines = await readTailLines(handle, size, bytes);
      const page = pageFromLines(lines, beforeSequence, limit);
      if (page.records.length >= limit || bytes === size) return page;
      bytes = Math.min(size, bytes * 2);
    }
  } finally { await handle.close(); }
}

export async function readJournalPrefix(path, limit) {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    let bytes = Math.min(size, 64 * 1024);
    while (true) {
      const buffer = Buffer.allocUnsafe(bytes);
      await handle.read(buffer, 0, bytes, 0);
      const lines = buffer.toString('utf8').split('\n').filter(Boolean);
      if (lines.length >= limit || bytes === size) return verifyPrefix(lines.slice(0, limit));
      bytes = Math.min(size, bytes * 2);
    }
  } finally { await handle.close(); }
}

function verifyPrefix(lines) {
  const records = [];
  let previous = '0'.repeat(64);
  for (const line of lines) {
    const record = parseRecord(line);
    if (journalFormat(record) === null || record.sequence !== records.length + 1
      || record.previous !== previous || record.hash !== digestWithoutHash(record)) {
      throw new ContractError('journal_corrupt', 'journal prefix is invalid');
    }
    records.push(record);
    previous = record.hash;
  }
  return records;
}

async function recoverJournalTail(path, tailLimit) {
  const limit = boundedLimit(tailLimit, 10_000);
  let handle;
  try { handle = await open(path, 'r'); } catch (error) {
    if (error.code === 'ENOENT') return emptyRecovery();
    throw error;
  }
  try {
    const { size } = await handle.stat();
    let bytes = Math.min(size, 64 * 1024);
    let lines = [];
    while (true) {
      lines = await readTailLines(handle, size, bytes);
      if (lines.length >= limit || bytes === size) break;
      bytes = Math.min(size, bytes * 2);
    }
    const truncated = bytes < size || lines.length > limit;
    return verifyTail(lines.slice(-limit), truncated);
  } finally { await handle.close(); }
}

async function readTailLines(handle, size, bytes) {
  if (size === 0) return [];
  const buffer = Buffer.allocUnsafe(bytes);
  await handle.read(buffer, 0, bytes, size - bytes);
  let text = buffer.toString('utf8');
  if (bytes < size) {
    const newline = text.indexOf('\n');
    text = newline < 0 ? '' : text.slice(newline + 1);
  }
  return text.split('\n').filter((line) => line.length > 0);
}

function verifyTail(lines, truncated) {
  const records = [];
  let previous = truncated ? null : '0'.repeat(64);
  let corruptTail = false;
  let legacyFormat = false;
  let priorSequence = null;
  for (const line of lines) {
    const record = parseRecord(line);
    const format = journalFormat(record);
    if (!record || format === null || (priorSequence !== null && record.sequence !== priorSequence + 1)
      || (previous !== null && record.previous !== previous) || record.hash !== digestWithoutHash(record)) {
      corruptTail = true;
      break;
    }
    legacyFormat ||= format === 0;
    records.push(record);
    previous = record.hash;
    priorSequence = record.sequence;
  }
  const lastHash = records.at(-1)?.hash ?? '0'.repeat(64);
  return recoveryResult(records, lastHash, corruptTail, truncated, legacyFormat);
}

function pageFromLines(lines, beforeSequence, limit) {
  const records = lines.map(parseRecord).filter((record) => record && record.hash === digestWithoutHash(record))
    .filter((record) => record.sequence < beforeSequence).slice(-limit);
  return Object.freeze({
    records: Object.freeze(records),
    beforeSequence: records[0]?.sequence ?? null,
    hasMore: records.length > 0 && records[0].sequence > 1,
  });
}

function recoveryResult(records, lastHash, corruptTail, truncated, legacyFormat = false) {
  return {
    records, lastHash, corruptTail, truncated, legacyFormat,
    lastSequence: records.at(-1)?.sequence ?? 0,
  };
}

async function migrateLegacyJournal(path, records) {
  const backup = `${path}.format-0.bak`;
  await copyFile(path, backup, constants.COPYFILE_EXCL).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const temporary = `${path}.migrate-${process.pid}`;
  let previous = '0'.repeat(64);
  const migrated = records.map((record, index) => {
    const base = { format: 1, sequence: index + 1, type: record.type, payload: record.payload, previous };
    const hash = digest(base);
    previous = hash;
    return JSON.stringify({ ...base, hash });
  });
  await writeFile(temporary, migrated.length ? `${migrated.join('\n')}\n` : '', { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
}

function encodeRecords(records) {
  let previous = '0'.repeat(64);
  return records.map((record, index) => {
    if (!record || typeof record.type !== 'string' || !Object.hasOwn(record, 'payload')) {
      throw new ContractError('journal_replace_invalid', 'replacement journal record is malformed');
    }
    const base = { format: 1, sequence: index + 1, type: record.type, payload: record.payload, previous };
    const hash = digest(base);
    previous = hash;
    return JSON.stringify({ ...base, hash });
  });
}

function journalFormat(record) {
  if (!record || typeof record !== 'object') return null;
  const format = record.format ?? 0;
  if (Number.isInteger(format) && format > 1) {
    throw new ContractError('journal_version_future', `journal format ${format} is newer than supported format 1`);
  }
  return format === 0 || format === 1 ? format : null;
}

function emptyRecovery() {
  return recoveryResult([], '0'.repeat(64), false, false);
}

function boundedLimit(value, fallback) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > 100_000) {
    throw new ContractError('invalid_journal_page', 'journal page limit is invalid');
  }
  return resolved;
}

function parseRecord(line) {
  // Callers verify record format, sequence, and hash.
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function digestWithoutHash(record) {
  const { hash: _hash, ...base } = record;
  return digest(base);
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
