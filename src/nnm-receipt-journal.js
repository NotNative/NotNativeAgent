// SPDX-License-Identifier: Apache-2.0
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ContractError } from './ids.js';

const MAX_BYTES = 4_194_304;
const READ_CHUNK_BYTES = 65_536;
const ISO_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)$/u;

export async function readBoundedReceiptJournal(path) {
  const handle = await open(path, 'r');
  try {
    if ((await handle.stat()).size > MAX_BYTES) throw receiptJournalTooLarge();
    const chunks = [];
    let length = 0;
    while (length <= MAX_BYTES) {
      const buffer = Buffer.alloc(Math.min(READ_CHUNK_BYTES, MAX_BYTES + 1 - length));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      length += bytesRead;
    }
    if (length > MAX_BYTES) throw receiptJournalTooLarge();
    return Buffer.concat(chunks, length).toString('utf8');
  } finally { await handle.close(); }
}

export function assertBoundedReceiptContent(content) {
  if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) throw receiptJournalTooLarge();
}

export function receiptProjectFingerprint(workspaceRoot) {
  return createHash('sha256').update(workspaceRoot).digest('hex');
}

export function writerUtcTimestampKey(value) {
  if (typeof value !== 'string') return null;
  const match = ISO_TIMESTAMP.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return null;
  const millis = `${match[1]}.${(match[2] ?? '').padEnd(3, '0').slice(0, 3)}Z`;
  if (new Date(value).toISOString() !== millis) return null;
  return `${match[1]}.${(match[2] ?? '').padEnd(6, '0')}Z`;
}

function receiptJournalTooLarge() {
  return new ContractError('nnm_receipts_too_large', `NNM receipt journal exceeds ${MAX_BYTES / 1_048_576} MiB`);
}
