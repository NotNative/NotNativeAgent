// SPDX-License-Identifier: Apache-2.0
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ContractError } from './ids.js';
import { userDataPaths } from './product.js';

const CONTRACT = 'nnm.turn-analysis-receipt/1.0';
const MAX_BYTES = 4_194_304;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const KEYS = new Set([
  'contract', 'receipt_id', 'session_id', 'turn_id', 'status', 'stored',
  'facts_stored', 'relationships_stored', 'summary_stored', 'candidates',
  'project_fingerprint', 'completed_at',
]);

export class NnmGovernanceReceipts {
  constructor(options = {}) {
    this.path = options.path ?? userDataPaths().nnmGovernanceReceipts;
    this.read = options.read ?? readReceiptFile;
    this.lastMalformedLines = 0;
  }

  async matching(input) {
    if (!input || typeof input !== 'object' || typeof input.workspaceRoot !== 'string' || !input.workspaceRoot) {
      throw new ContractError('nnm_receipt_query_invalid', 'NNM receipt matching requires a workspace root');
    }
    for (const values of [input.turnIds ?? [], input.sessionIds ?? []]) {
      if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !value)) {
        throw new ContractError('nnm_receipt_query_invalid', 'NNM receipt identifiers must be arrays of non-empty strings');
      }
    }
    const turns = new Set(input.turnIds ?? []);
    const sessions = new Set(input.sessionIds ?? []);
    const project = digest(input.workspaceRoot);
    let content;
    try { content = await this.read(this.path, 'utf8'); }
    catch (error) { if (error?.code === 'ENOENT') return Object.freeze([]); throw error; }
    if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) {
      throw new ContractError('nnm_receipts_too_large', 'NNM governance receipt journal exceeds 4 MiB');
    }
    const found = new Map();
    let malformedLines = 0;
    for (const match of content.matchAll(/[^\r\n]+/gu)) {
      const line = match[0];
      if (!line.trim()) continue;
      let parsed;
      try { parsed = normalize(JSON.parse(line)); } catch { malformedLines += 1; continue; }
      if (parsed.project_fingerprint !== project || !turns.has(parsed.turn_id)
          || (sessions.size > 0 && !sessions.has(parsed.session_id))) continue;
      found.set(parsed.receipt_id, parsed);
    }
    this.lastMalformedLines = malformedLines;
    return Object.freeze([...found.values()]);
  }
}

async function readReceiptFile(path) {
  const handle = await open(path, 'r');
  try {
    if ((await handle.stat()).size > MAX_BYTES) throw new ContractError('nnm_receipts_too_large', 'NNM governance receipt journal exceeds 4 MiB');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_BYTES) throw new ContractError('nnm_receipts_too_large', 'NNM governance receipt journal exceeds 4 MiB');
    return buffer.subarray(0, length).toString('utf8');
  } finally { await handle.close(); }
}

function normalize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => !KEYS.has(key)) || value.contract !== CONTRACT) {
    throw new ContractError('nnm_receipt_invalid', 'NNM governance receipt is malformed');
  }
  for (const key of ['receipt_id', 'session_id', 'turn_id', 'project_fingerprint']) bounded(value[key], key);
  if (!/^[a-f0-9]{64}$/u.test(value.receipt_id) || !/^[a-f0-9]{64}$/u.test(value.project_fingerprint)
      || value.status !== 'completed' || typeof value.completed_at !== 'string'
      || !ISO_TIMESTAMP.test(value.completed_at) || new Date(value.completed_at).toISOString() !== value.completed_at) {
    throw new ContractError('nnm_receipt_invalid', 'NNM governance receipt attribution is invalid');
  }
  const result = { ...value };
  for (const key of ['stored', 'facts_stored', 'relationships_stored', 'candidates']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 1_000_000) {
      throw new ContractError('nnm_receipt_invalid', 'NNM governance receipt count is invalid');
    }
  }
  if (typeof value.summary_stored !== 'boolean') throw new ContractError('nnm_receipt_invalid', 'NNM receipt summary flag is invalid');
  return Object.freeze(result);
}

function bounded(value, label) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 160) {
    throw new ContractError('nnm_receipt_invalid', `${label} is invalid`);
  }
}
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
