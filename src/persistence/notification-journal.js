// SPDX-License-Identifier: Apache-2.0
import { lstat, open } from 'node:fs/promises';
import { ContractError } from '../ids.js';
import { digestWithoutHash, journalFormat } from '../store.js';

const MAX_NOTIFICATION_RECORD_BYTES = 33_554_432;

export async function readVerifiedTurnOutcomes(path, options = {}) {
  const turnIds = options.turnIds;
  const maxRecordBytes = options.maxRecordBytes ?? MAX_NOTIFICATION_RECORD_BYTES;
  if (!(turnIds instanceof Set) || turnIds.size < 1 || turnIds.size > 1_024
    || !Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1) {
    throw new ContractError('notification_journal_scan_invalid', 'notification journal scan parameters are invalid');
  }
  let expected;
  try { expected = await lstat(path); }
  catch (error) { if (error?.code === 'ENOENT') return new Map(); throw error; }
  if (!expected.isFile() || expected.isSymbolicLink()) {
    throw new ContractError('notification_journal_path_unsafe', 'notification source journal is not a regular file');
  }
  let handle;
  try { handle = await open(path, 'r'); }
  catch (error) { if (error?.code === 'ENOENT') return new Map(); throw error; }
  try {
    const { size, dev, ino } = await handle.stat();
    if (dev !== expected.dev || ino !== expected.ino) {
      throw new ContractError('notification_journal_path_changed', 'notification source journal path changed before verification');
    }
    if (size === 0) return new Map();
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
    // Invariant: one handle and a fixed byte range pin verification to one journal snapshot.
    const stream = handle.createReadStream({ highWaterMark: 65_536, end: size - 1,
      autoClose: false, signal: options.signal });
    const state = { previous: '0'.repeat(64), sequence: 0, outcomes: new Map() };
    let parts = [];
    let pendingBytes = 0;
    let readBytes = 0;
    for await (const chunk of stream) {
      readBytes += chunk.length;
      let start = 0;
      for (let index = 0; index < chunk.length; index += 1) {
        if (chunk[index] !== 10) continue;
        const segment = chunk.subarray(start, index);
        checkRecordLength(pendingBytes + segment.length, maxRecordBytes);
        if (segment.length > 0) parts.push(segment);
        acceptLine(Buffer.concat(parts, pendingBytes + segment.length), state, turnIds);
        parts = [];
        pendingBytes = 0;
        start = index + 1;
      }
      const remainder = chunk.subarray(start);
      checkRecordLength(pendingBytes + remainder.length, maxRecordBytes);
      if (remainder.length > 0) { parts.push(remainder); pendingBytes += remainder.length; }
    }
    if (readBytes !== size) throw new ContractError('notification_journal_changed', 'notification source journal changed during verification');
    if (pendingBytes > 0) acceptLine(Buffer.concat(parts, pendingBytes), state, turnIds);
    return state.outcomes;
  } finally { await handle.close(); }
}

function checkRecordLength(length, maximum) {
  if (length > maximum) {
    throw new ContractError('notification_journal_record_too_large', 'notification source journal record exceeds its bound');
  }
}

function acceptLine(line, state, turnIds) {
  if (line.length === 0) return;
  let record;
  try { record = JSON.parse(line.toString('utf8')); } catch { /* Invalid journal line. */ }
  if (!record || journalFormat(record) === null || record.sequence !== state.sequence + 1
    || record.previous !== state.previous || record.hash !== digestWithoutHash(record)) {
    throw new ContractError('notification_journal_invalid', 'notification source journal is invalid');
  }
  state.sequence += 1;
  state.previous = record.hash;
  if (record.type === 'turn_outcome' && turnIds.has(record.payload?.turn_id)
    && typeof record.payload?.outcome === 'string') state.outcomes.set(record.payload.turn_id, record.payload.outcome);
}
