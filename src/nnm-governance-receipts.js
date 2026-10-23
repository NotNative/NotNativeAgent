// SPDX-License-Identifier: Apache-2.0
import { isDeepStrictEqual } from 'node:util';
import { ContractError } from './ids.js';
import { assertBoundedReceiptContent, readBoundedReceiptJournal, receiptProjectFingerprint, writerUtcTimestampKey } from './nnm-receipt-journal.js';
import { userDataPaths } from './product.js';

const CONTRACT = 'nnm.turn-analysis-receipt/1.0';
const KEYS = new Set([
  'contract', 'receipt_id', 'session_id', 'turn_id', 'status', 'stored',
  'facts_stored', 'relationships_stored', 'summary_stored', 'candidates',
  'project_fingerprint', 'completed_at', 'related_memories_considered', 'reason',
]);
const STATUSES = new Set(['completed', 'partial', 'skipped', 'failed']);

export class NnmGovernanceReceipts {
  constructor(options = {}) {
    this.path = options.path ?? userDataPaths().nnmGovernanceReceipts;
    this.read = options.read ?? readBoundedReceiptJournal;
    this.onDiagnostic = typeof options.onDiagnostic === 'function' ? options.onDiagnostic : null;
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
    const project = receiptProjectFingerprint(input.workspaceRoot);
    let content;
    try { content = await this.read(this.path, 'utf8'); }
    catch (error) { if (error?.code === 'ENOENT') return Object.freeze([]); throw error; }
    assertBoundedReceiptContent(content);
    const found = new Map();
    const conflicted = new Set();
    let malformedLines = 0;
    for (const match of content.matchAll(/[^\r\n]+/gu)) {
      const line = match[0];
      if (!line.trim()) continue;
      let parsed;
      try {
        const value = JSON.parse(line);
        // Why: NNM writes turn-analysis and hygiene receipts to the same journal.
        if (value?.contract === 'nnm.hygiene-receipt/1.0') continue;
        parsed = normalize(value);
      } catch { malformedLines += 1; continue; }
      if (conflicted.has(parsed.receipt_id)) { malformedLines += 1; continue; }
      const previous = found.get(parsed.receipt_id);
      if (previous && !isDeepStrictEqual(previous, parsed)) {
        const sameAttribution = previous.session_id === parsed.session_id
          && previous.turn_id === parsed.turn_id && previous.project_fingerprint === parsed.project_fingerprint;
        // Why: NNM reuses an ID when a failed analyzer attempt is retried for the same turn.
        if (!sameAttribution || previous.status === 'completed'
            || writerUtcTimestampKey(parsed.completed_at) <= writerUtcTimestampKey(previous.completed_at)) {
          found.delete(parsed.receipt_id); conflicted.add(parsed.receipt_id); malformedLines += 1; continue;
        }
      }
      found.set(parsed.receipt_id, parsed);
    }
    if (malformedLines > 0) {
      try { this.onDiagnostic?.({ code: 'nnm_receipt_lines_malformed', count: malformedLines }); }
      catch { /* Diagnostics cannot change receipt admission. */ }
    }
    return Object.freeze([...found.values()].filter((receipt) => receipt.project_fingerprint === project
      && (turns.size > 0 || sessions.size > 0)
      && (turns.size === 0 || turns.has(receipt.turn_id))
      && (sessions.size === 0 || sessions.has(receipt.session_id))));
  }
}

function normalize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => !KEYS.has(key)) || value.contract !== CONTRACT) {
    throw new ContractError('nnm_receipt_invalid', 'NNM governance receipt is malformed');
  }
  for (const key of ['receipt_id', 'session_id', 'turn_id', 'project_fingerprint']) bounded(value[key], key);
  if (!/^[a-f0-9]{64}$/u.test(value.receipt_id) || !/^[a-f0-9]{64}$/u.test(value.project_fingerprint)
      || !STATUSES.has(value.status) || writerUtcTimestampKey(value.completed_at) === null
      || (value.reason !== undefined && (typeof value.reason !== 'string' || Buffer.byteLength(value.reason, 'utf8') > 2_000))) {
    throw new ContractError('nnm_receipt_invalid', 'NNM governance receipt attribution is invalid');
  }
  for (const key of ['stored', 'facts_stored', 'relationships_stored', 'candidates', 'related_memories_considered']) {
    if (key === 'related_memories_considered' && value[key] === undefined) continue;
    if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 1_000_000) {
      throw new ContractError('nnm_receipt_invalid', 'NNM governance receipt count is invalid');
    }
  }
  if (typeof value.summary_stored !== 'boolean') throw new ContractError('nnm_receipt_invalid', 'NNM receipt summary flag is invalid');
  // Security: exception text from NNM's reason field must not enter NNA governance evidence.
  return Object.freeze({
    contract: value.contract, receipt_id: value.receipt_id, session_id: value.session_id,
    turn_id: value.turn_id, status: value.status, stored: value.stored,
    facts_stored: value.facts_stored, relationships_stored: value.relationships_stored,
    summary_stored: value.summary_stored, candidates: value.candidates,
    project_fingerprint: value.project_fingerprint, completed_at: value.completed_at,
    may_retry: value.status === 'failed' && value.reason !== undefined,
    ...(value.related_memories_considered === undefined ? {} : { related_memories_considered: value.related_memories_considered }),
  });
}

function bounded(value, label) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 160) {
    throw new ContractError('nnm_receipt_invalid', `${label} is invalid`);
  }
}
