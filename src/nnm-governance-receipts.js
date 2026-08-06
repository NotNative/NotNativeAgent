// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ContractError } from './ids.js';
import { userDataPaths } from './product.js';

const CONTRACT = 'nnm.turn-analysis-receipt/1.0';
const MAX_BYTES = 4_194_304;
const KEYS = new Set([
  'contract', 'receipt_id', 'session_id', 'turn_id', 'status', 'stored',
  'facts_stored', 'relationships_stored', 'summary_stored', 'candidates',
  'project_fingerprint', 'completed_at',
]);

export class NnmGovernanceReceipts {
  constructor(options = {}) {
    this.path = options.path ?? userDataPaths().nnmGovernanceReceipts;
    this.read = options.read ?? readFile;
  }

  async matching(input) {
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
    for (const line of content.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      let parsed;
      try { parsed = normalize(JSON.parse(line)); } catch { continue; }
      if (parsed.project_fingerprint !== project || !turns.has(parsed.turn_id)
          || (sessions.size > 0 && !sessions.has(parsed.session_id))) continue;
      found.set(parsed.receipt_id, parsed);
    }
    return Object.freeze([...found.values()]);
  }
}

function normalize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => !KEYS.has(key)) || value.contract !== CONTRACT) {
    throw new ContractError('nnm_receipt_invalid', 'NNM governance receipt is malformed');
  }
  for (const key of ['receipt_id', 'session_id', 'turn_id', 'project_fingerprint']) bounded(value[key], key);
  if (!/^[a-f0-9]{64}$/u.test(value.receipt_id) || !/^[a-f0-9]{64}$/u.test(value.project_fingerprint)
      || value.status !== 'completed' || Number.isNaN(Date.parse(value.completed_at))) {
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
