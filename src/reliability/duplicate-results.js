// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';

const DEFAULT_MINIMUM_SAVINGS_BYTES = 512;
const RECEIPT_SCHEMA = 'nna.duplicate-result-receipt.v1';

export function projectDuplicateToolResults(records, protectedIndexes = new Set(), options = {}) {
  const minimumSavingsBytes = positiveInteger(options.minimumSavingsBytes)
    ? options.minimumSavingsBytes : DEFAULT_MINIMUM_SAVINGS_BYTES;
  const latestByDigest = new Map();
  const digestByIndex = new Map();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!eligible(record)) continue;
    const digest = contentDigest(record.content);
    digestByIndex.set(index, digest);
    latestByDigest.set(digest, index);
  }

  let duplicateRecords = 0;
  let bytesSaved = 0;
  const projected = records.map((record, index) => {
    if (protectedIndexes.has(index)) return record;
    const digest = digestByIndex.get(index);
    const duplicateOfIndex = digest === undefined ? index : latestByDigest.get(digest);
    if (duplicateOfIndex === index) return record;
    const duplicateOf = records[duplicateOfIndex];
    const receipt = duplicateReceipt(record, duplicateOf, duplicateOfIndex, digest);
    const originalBytes = recordBytes(record);
    const projectedBytes = recordBytes(receipt);
    if (originalBytes - projectedBytes < minimumSavingsBytes) return record;
    duplicateRecords += 1;
    bytesSaved += originalBytes - projectedBytes;
    return receipt;
  });
  return Object.freeze({ records: Object.freeze(projected), duplicateRecords, bytesSaved });
}

export function duplicateResultContentDigest(content) { return contentDigest(content); }

function duplicateReceipt(record, duplicateOf, duplicateOfIndex, digest) {
  const ledgerRef = ledgerReference(record);
  const duplicateOfRef = ledgerReference(duplicateOf);
  const receipt = Object.freeze({
    schema: RECEIPT_SCHEMA,
    tool: record.toolName ?? 'unknown',
    outcome: record.status,
    content_sha256: digest,
    original_bytes: Buffer.byteLength(record.content, 'utf8'),
    ledger_ref: ledgerRef,
    duplicate_of: Object.freeze({
      record_index: duplicateOfIndex,
      ledger_ref: duplicateOfRef,
      provider_call_id: duplicateOf.providerCallId ?? null,
      request_id: duplicateOf.requestId ?? null,
    }),
  });
  return {
    ...record,
    content: JSON.stringify(receipt),
    metadata: {
      ...boundedMetadata(record.metadata), compacted: true,
      reason: 'duplicate_result', compressionClass: 'recoverable',
      reducer: 'content_identity_dedup_v1', ledgerRef,
      resultFingerprint: digest, receiptSchema: RECEIPT_SCHEMA,
      duplicateOfLedgerRef: duplicateOfRef, duplicateOfRecordIndex: duplicateOfIndex,
    },
  };
}

function eligible(record) {
  return record?.type === 'tool_result'
    && record.status === 'succeeded'
    && typeof record.content === 'string'
    && record.metadata?.reason !== 'duplicate_result';
}

function contentDigest(content) {
  return createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
}

function ledgerReference(record) {
  return record.requestId ?? record.providerCallId ?? record.turnId ?? record.turn_id ?? null;
}

function boundedMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8') <= 2_048 ? value : {}; }
  catch { return {}; }
}

function recordBytes(record) {
  try { return Buffer.byteLength(JSON.stringify(record), 'utf8'); }
  catch { return Number.MAX_SAFE_INTEGER; }
}

function positiveInteger(value) { return Number.isSafeInteger(value) && value >= 0; }
