// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ContractError } from './ids.js';
import { userDataPaths } from './product.js';

const CONTRACT = 'nnm.hygiene-receipt/1.0';
const MAX_BYTES = 4_194_304;
const KEYS = new Set([
  'contract', 'receipt_id', 'session_id', 'status', 'candidates', 'categories',
  'project_fingerprint', 'completed_at',
]);
const REQUIRED_KEYS = Object.freeze([...KEYS]);

export class NnmHygieneReceipts {
  constructor(options = {}) {
    this.path = options.path ?? userDataPaths().nnmGovernanceReceipts;
    this.read = options.read ?? readFile;
    this.onDiagnostic = typeof options.onDiagnostic === 'function' ? options.onDiagnostic : null;
  }

  async latest(input) {
    if (!input || typeof input.workspaceRoot !== 'string' || input.workspaceRoot.length === 0) {
      throw new ContractError('nnm_receipt_query_invalid', 'NNM receipt query requires a workspace root');
    }
    const since = input.since ?? 0;
    if (!Number.isFinite(since) || since < 0) {
      throw new ContractError('nnm_receipt_query_invalid', 'NNM receipt query since value must be a timestamp');
    }
    const project = digest(input.workspaceRoot);
    let content;
    try { content = await this.read(this.path, 'utf8'); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
    if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) {
      throw new ContractError('nnm_receipts_too_large', 'NNM governance receipt journal exceeds 4 MiB');
    }
    let latest = null;
    let malformedLines = 0;
    for (const line of content.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      let parsed;
      try { parsed = normalize(JSON.parse(line)); } catch { malformedLines += 1; continue; }
      if (parsed.project_fingerprint !== project || Date.parse(parsed.completed_at) < since) continue;
      if (!latest || parsed.completed_at > latest.completed_at) latest = parsed;
    }
    if (malformedLines > 0) this.onDiagnostic?.({ code: 'nnm_receipt_lines_malformed', count: malformedLines });
    return latest;
  }
}

function normalize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => !KEYS.has(key))
      || REQUIRED_KEYS.some((key) => !Object.hasOwn(value, key)) || value.contract !== CONTRACT) {
    throw new ContractError('nnm_hygiene_receipt_invalid', 'NNM hygiene receipt is malformed');
  }
  for (const key of ['receipt_id', 'session_id', 'project_fingerprint']) bounded(value[key], key);
  if (!/^[a-f0-9]{64}$/u.test(value.receipt_id) || !/^[a-f0-9]{64}$/u.test(value.project_fingerprint)
      || value.status !== 'completed' || Number.isNaN(Date.parse(value.completed_at))
      || !Number.isSafeInteger(value.candidates) || value.candidates < 0 || value.candidates > 100) {
    throw new ContractError('nnm_hygiene_receipt_invalid', 'NNM hygiene receipt attribution is invalid');
  }
  if (!value.categories || typeof value.categories !== 'object' || Array.isArray(value.categories)
      || Object.keys(value.categories).length > 32) {
    throw new ContractError('nnm_hygiene_receipt_invalid', 'NNM hygiene receipt categories are invalid');
  }
  for (const [key, count] of Object.entries(value.categories)) {
    bounded(key, 'category');
    if (!Number.isSafeInteger(count) || count < 0 || count > 100) {
      throw new ContractError('nnm_hygiene_receipt_invalid', 'NNM hygiene receipt category count is invalid');
    }
  }
  return Object.freeze({ ...value, categories: Object.freeze({ ...value.categories }) });
}

function bounded(value, field) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 160) {
    throw new ContractError('nnm_hygiene_receipt_invalid', `NNM hygiene receipt ${field} is invalid`);
  }
}
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
