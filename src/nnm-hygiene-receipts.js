// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { assertBoundedReceiptContent, readBoundedReceiptJournal, receiptProjectFingerprint, writerUtcTimestampKey } from './nnm-receipt-journal.js';
import { userDataPaths } from './product.js';

const CONTRACT = 'nnm.hygiene-receipt/1.0';
const KEYS = new Set([
  'contract', 'receipt_id', 'session_id', 'status', 'candidates', 'categories',
  'project_fingerprint', 'completed_at',
]);
const REQUIRED_KEYS = Object.freeze([...KEYS]);
const CATEGORY_CODES = new Set(['unresolved_conflict', 'hot_unclassified', 'cold_model_inferred', 'lint_warning', 'other']);

export class NnmHygieneReceipts {
  constructor(options = {}) {
    this.path = options.path ?? userDataPaths().nnmGovernanceReceipts;
    this.read = options.read ?? readBoundedReceiptJournal;
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
    const project = receiptProjectFingerprint(input.workspaceRoot);
    let content;
    try { content = await this.read(this.path, 'utf8'); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
    assertBoundedReceiptContent(content);
    let latest = null, latestKey = null, malformedAfterLatest = false;
    let malformedLines = 0;
    for (const match of content.matchAll(/[^\r\n]+/gu)) {
      const line = match[0];
      if (!line.trim()) continue;
      let parsed, value;
      try {
        value = JSON.parse(line);
        // Why: NNM writes turn-analysis and hygiene receipts to the same journal.
        if (value?.contract === 'nnm.turn-analysis-receipt/1.0') continue;
        parsed = normalize(value);
      } catch {
        malformedLines += 1;
        // Why: a later malformed receipt may represent this scan; do not admit an older scan as current.
        if (latest && (!value || value.project_fingerprint === project
            && String(value.contract ?? '').startsWith('nnm.hygiene-receipt/'))) malformedAfterLatest = true;
        continue;
      }
      if (parsed.project_fingerprint !== project || Date.parse(parsed.completed_at) < since) continue;
      const key = writerUtcTimestampKey(parsed.completed_at);
      if (!latest || key >= latestKey) { latest = parsed; latestKey = key; malformedAfterLatest = false; }
    }
    if (malformedLines > 0) {
      try { this.onDiagnostic?.({ code: 'nnm_receipt_lines_malformed', count: malformedLines }); }
      catch { /* Diagnostics cannot change receipt admission. */ }
    }
    return malformedAfterLatest ? null : latest;
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
      || value.status !== 'completed' || writerUtcTimestampKey(value.completed_at) === null
      || !Number.isSafeInteger(value.candidates) || value.candidates < 0 || value.candidates > 100) {
    throw new ContractError('nnm_hygiene_receipt_invalid', 'NNM hygiene receipt attribution is invalid');
  }
  if (!value.categories || typeof value.categories !== 'object' || Array.isArray(value.categories)
      || Object.keys(value.categories).length > 32) {
    throw new ContractError('nnm_hygiene_receipt_invalid', 'NNM hygiene receipt categories are invalid');
  }
  let totalReasons = 0;
  for (const [key, count] of Object.entries(value.categories)) {
    if (!CATEGORY_CODES.has(key)) throw new ContractError('nnm_hygiene_receipt_invalid', 'NNM hygiene receipt category is invalid');
    // Invariant: NNM emits at most 16 reasons for each of at most 100 candidates.
    if (!Number.isSafeInteger(count) || count < 0 || count > 1_600) {
      throw new ContractError('nnm_hygiene_receipt_invalid', 'NNM hygiene receipt category count is invalid');
    }
    totalReasons += count;
  }
  if (totalReasons > 16 * value.candidates) {
    throw new ContractError('nnm_hygiene_receipt_invalid', 'NNM hygiene receipt category total is invalid');
  }
  return Object.freeze({ ...value, categories: Object.freeze({ ...value.categories }) });
}

function bounded(value, field) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 160) {
    throw new ContractError('nnm_hygiene_receipt_invalid', `NNM hygiene receipt ${field} is invalid`);
  }
}
