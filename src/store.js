// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { ContractError } from './ids.js';

const MAX_FULL_JOURNAL_SCAN_BYTES = 104_857_600;
const MAX_CONTROL_RECORDS = 100_000;
const AUTHORITY_CONTROL_TYPES = new Set([
  'authority_intent', 'conversation_cleared', 'mission_turn_authorized', 'mission_tool_calls_reserved',
]);

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
    this.controlScanMaxBytes = options.controlScanMaxBytes ?? MAX_FULL_JOURNAL_SCAN_BYTES;
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
    // Why: authority and mission budgets are small control facts whose completeness
    // must not depend on how much of the large transcript tail the resume window kept.
    const control = recovered.truncated
      ? await recoverControlRecords(this.path, { maxBytes: this.controlScanMaxBytes, expectedTip: recovered.lastHash })
      : null;
    this.#sequence = recovered.lastSequence;
    this.#previousHash = recovered.lastHash;
    this.#handle = await this.openFile(this.path, 'a', 0o600);
    const headerRecords = recovered.truncated ? await readJournalPrefix(this.path, 1) : recovered.records.slice(0, 1);
    return {
      ...recovered, headerRecords,
      ...(control ? { controlRecords: control.controlRecords, controlComplete: control.controlComplete } : {}),
    };
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
    const temporary = `${this.path}.replace-${process.pid}-${randomUUID()}`;
    const lines = encodeRecords(records);
    try {
      const replacement = await open(temporary, 'wx', 0o600);
      try {
        await replacement.writeFile(lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
        await replacement.sync();
      } finally { await replacement.close(); }
      await rename(temporary, this.path);
      await syncDirectory(this.root);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
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

async function syncDirectory(path) {
  if (process.platform === 'win32') return;
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function recoverJournal(path, options = {}) {
  if (options.tailLimit !== undefined) return recoverJournalTail(path, options.tailLimit);
  let details;
  try { details = await stat(path); } catch (error) {
    if (error.code === 'ENOENT') return emptyRecovery();
    throw error;
  }
  if (details.size > (options.maxBytes ?? MAX_FULL_JOURNAL_SCAN_BYTES)) {
    throw new ContractError('journal_too_large_to_repair_in_process', 'journal exceeds the bounded full-scan limit; use an explicit offline repair or archival workflow');
  }
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

export async function rewriteJournal(path, records) {
  if (!Array.isArray(records) || records.length > 100_000) throw new ContractError('journal_replace_invalid', 'replacement journal records are invalid');
  const temporary = `${path}.rewrite-${process.pid}-${randomUUID()}`;
  try {
    const replacement = await open(temporary, 'wx', 0o600);
    try {
      const lines = encodeRecords(records);
      await replacement.writeFile(lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
      await replacement.sync();
    } finally { await replacement.close(); }
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
}

export async function restoreJournalFromVerifiedPrefix(path, prefixPath, options = {}) {
  const recovered = await inspectJournalRepairPrefix(prefixPath, options);
  const evidencePath = `${path}.corrupt.${Date.now()}.${randomUUID()}`;
  const temporary = `${path}.repair-${process.pid}-${randomUUID()}`;
  try {
    await copyFile(prefixPath, temporary, constants.COPYFILE_EXCL);
    const handle = await open(temporary, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    await rename(path, evidencePath);
    try { await rename(temporary, path); }
    catch (error) { await rename(evidencePath, path).catch(() => undefined); throw error; }
    await syncDirectory(dirname(path));
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
  return Object.freeze({ records: recovered.records.length, evidence_path: evidencePath, prefix_path: prefixPath });
}

export async function inspectJournalRepairPrefix(prefixPath, options = {}) {
  const maximum = options.maxBytes ?? 104_857_600;
  const details = await stat(prefixPath);
  if (details.size > maximum) throw new ContractError('journal_repair_prefix_too_large', 'verified journal prefix exceeds the repair bound');
  const recovered = await recoverJournal(prefixPath);
  if (recovered.corruptTail || recovered.legacyFormat || recovered.records.length === 0
    || recovered.records[0].sequence !== 1 || recovered.records[0].previous !== '0'.repeat(64)) {
    throw new ContractError('journal_repair_prefix_invalid', 'verified journal prefix does not form a complete genesis chain');
  }
  return recovered;
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

export async function readJournalPrefix(path, limit, options = {}) {
  const handle = await (options.openFile ?? open)(path, 'r');
  try {
    const { size } = await handle.stat();
    let bytes = Math.min(size, 64 * 1024);
    while (true) {
      const buffer = Buffer.allocUnsafe(bytes);
      const window = await readWindow(handle, buffer, 0);
      const lines = window.toString('utf8').split('\n').filter(Boolean);
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

// Security: the control scan verifies the whole hash chain from genesis because a
// resumed authority claim is only as trustworthy as the lineage it was read through.
// Anything unverifiable fails closed: the caller keeps the authority-incomplete posture.
export async function recoverControlRecords(path, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_FULL_JOURNAL_SCAN_BYTES;
  const maxRecords = options.maxControlRecords ?? MAX_CONTROL_RECORDS;
  let size;
  try { size = (await stat(path)).size; } catch (error) {
    if (error.code === 'ENOENT') {
      // Security: a vanished journal can only attest completeness when the caller has
      // nothing to anchor it against; a missing file under an expected tip is a loss.
      return Object.freeze({ controlRecords: Object.freeze([]), controlComplete: options.expectedTip === undefined });
    }
    throw error;
  }
  if (size > maxBytes) return Object.freeze({ controlRecords: Object.freeze([]), controlComplete: false });
  const records = [];
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: 0 });
  let previous = '0'.repeat(64);
  let sequence = 0;
  let complete = true;
  try {
    for await (const line of lines) {
      if (line.length === 0) continue;
      const record = parseRecord(line);
      let format;
      try { format = journalFormat(record); } catch { complete = false; break; }
      if (!record || format !== 1 || record.sequence !== sequence + 1
        || record.previous !== previous || record.hash !== digestWithoutHash(record)) {
        complete = false;
        break;
      }
      sequence += 1;
      if (AUTHORITY_CONTROL_TYPES.has(record.type)) {
        if (records.length >= maxRecords) { complete = false; break; }
        records.push(record);
      }
      previous = record.hash;
    }
  } catch {
    complete = false;
  } finally {
    lines.close();
    stream.destroy();
  }
  // Security: a scan that stops short of the tail-verified end of file (a prefix
  // swapped in by sync or backup restore, or a silent short read) would otherwise
  // attest completeness for a prefix and roll authority back across a clear. The
  // expected tip pins the scan to the same bytes the resumed tail already verified.
  if (complete && options.expectedTip !== undefined && previous !== options.expectedTip) complete = false;
  return Object.freeze({ controlRecords: Object.freeze(records), controlComplete: complete });
}

async function readTailLines(handle, size, bytes) {
  if (size === 0) return [];
  const buffer = Buffer.allocUnsafe(bytes);
  const window = await readWindow(handle, buffer, size - bytes);
  let text = window.toString('utf8');
  if (bytes < size) {
    const newline = text.indexOf('\n');
    text = newline < 0 ? '' : text.slice(newline + 1);
  }
  return text.split('\n').filter((line) => line.length > 0);
}

async function readWindow(handle, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, position + offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
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
