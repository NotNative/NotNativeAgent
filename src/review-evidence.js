// SPDX-License-Identifier: Apache-2.0
import { redactText } from './redaction.js';

const RECENT_TURNS = 3;
const MAX_RECORDS = 10;
const MAX_RECENT_RECORDS = 6;
const MAX_HISTORY_MATCHES = 4;
const MAX_ITEM_BYTES = 2_048;
const MAX_TOTAL_BYTES = 12_288;
const MAX_SCAN_RECORDS = 50_000;
const MAX_QUERY_TERMS = 32;
const MAX_SEARCH_DEPTH = 10;
const MAX_SEARCH_CHILDREN = 64;
const IGNORED_KEYS = /(?:auth|credential|password|secret|token|key)/iu;
const STOP_WORDS = new Set([
  'about', 'after', 'again', 'could', 'from', 'have', 'into', 'just', 'more', 'only',
  'please', 'request', 'should', 'that', 'their', 'then', 'there', 'these', 'they',
  'this', 'tool', 'using', 'want', 'what', 'when', 'where', 'which', 'with', 'would',
]);

export function buildReviewEvidence(transcript, options = {}) {
  const records = Array.isArray(transcript) ? transcript : [];
  const currentRequestId = options.currentRequestId ?? null;
  const currentTurnId = options.currentTurnId ?? findCurrentTurn(records, currentRequestId);
  const terms = queryTerms(options.request, options.authenticatedIntent, options.justification,
    options.activeTaskIntent);
  const recentTurnIds = newestTurnIds(records, currentTurnId);
  const candidates = [];
  let scanned = 0;

  for (let index = records.length - 1; index >= 0 && scanned < MAX_SCAN_RECORDS; index -= 1) {
    scanned += 1;
    const item = evidenceItem(records[index], currentRequestId, index);
    if (!item) continue;
    const relevance = relevanceScore(item, terms);
    if (recentTurnIds.has(item.turnId)) {
      candidates.push({ ...item, source: 'recent', relevance });
      continue;
    }
    if (relevance > 0) candidates.push({ ...item, source: 'history_match', relevance });
  }

  const recent = candidates
    .filter((item) => item.source === 'recent')
    .sort((left, right) => left.recordIndex - right.recordIndex);
  const recentTail = recent.slice(-MAX_RECENT_RECORDS);
  const recentTailIndexes = new Set(recentTail.map((item) => item.recordIndex));
  const relevant = candidates
    .filter((item) => item.relevance > 0 && !recentTailIndexes.has(item.recordIndex))
    .sort((left, right) => right.relevance - left.relevance || right.recordIndex - left.recordIndex);
  const selected = [...recentTail, ...relevant.slice(0, MAX_HISTORY_MATCHES)]
    .filter((item, index, all) => all.findIndex((entry) => entry.recordIndex === item.recordIndex) === index)
    .slice(0, MAX_RECORDS)
    .sort((left, right) => left.recordIndex - right.recordIndex);

  const evidence = [];
  let remaining = MAX_TOTAL_BYTES;
  for (const item of selected) {
    const content = takeBytes(item.content, Math.min(MAX_ITEM_BYTES, remaining));
    if (content.length === 0) continue;
    const contentBytes = Buffer.byteLength(content, 'utf8');
    if (contentBytes > remaining) continue;
    evidence.push(Object.freeze({ ...item, content }));
    remaining -= contentBytes;
    if (remaining <= 0) break;
  }

  const packetBytes = MAX_TOTAL_BYTES - remaining;
  const metadata = Object.freeze({
    recordsScanned: scanned,
    scanTruncated: scanned < records.length,
    recentRecords: evidence.filter((item) => item.source === 'recent').length,
    historyMatches: evidence.filter((item) => item.source === 'history_match').length,
    matchedRecordIndexes: Object.freeze(evidence.map((item) => item.recordIndex)),
    relevanceScores: Object.freeze(evidence.map((item) => item.relevance)),
    packetBytes,
    packetTruncated: selected.length > evidence.length || candidates.length > selected.length,
  });
  return Object.freeze({ evidence: Object.freeze(evidence), metadata });
}

export function recentReviewEvidence(transcript, currentRequestId) {
  return buildReviewEvidence(transcript, { currentRequestId }).evidence;
}

function evidenceItem(record, currentRequestId, recordIndex) {
  if (!record || record.requestId === currentRequestId) return null;
  if (record.type === 'message' && record.role === 'assistant' && !record.partial) {
    if (record.content === null || record.content === undefined) return null;
    return {
      type: 'assistant_message', trust: 'untrusted_model', turnId: record.turnId ?? null,
      recordIndex, content: redactText(record.content),
    };
  }
  if (record.type === 'tool_result') {
    if (record.content === null || record.content === undefined) return null;
    return {
      type: 'tool_result', trust: 'untrusted_tool', turnId: record.turnId ?? null,
      recordIndex, tool: record.toolName, status: record.status, content: redactText(record.content),
    };
  }
  return null;
}

function findCurrentTurn(records, currentRequestId) {
  if (!currentRequestId) return null;
  return records.findLast((record) => record?.requestId === currentRequestId)?.turnId ?? null;
}

function newestTurnIds(records, currentTurnId) {
  const result = new Set();
  if (currentTurnId) result.add(currentTurnId);
  for (let index = records.length - 1; index >= 0 && result.size < RECENT_TURNS; index -= 1) {
    const turnId = records[index]?.turnId;
    if (turnId) result.add(turnId);
  }
  // Legacy transcripts may not carry turn IDs; treat their bounded newest records as recent.
  if (result.size === 0) result.add(null);
  return result;
}

function queryTerms(request, authenticatedIntent, justification, activeTaskIntent) {
  const values = [];
  for (const item of (activeTaskIntent ?? []).slice(-32)) collectSearchValues(item, values);
  for (const item of (authenticatedIntent ?? []).slice(-3)) collectSearchValues(item?.content, values);
  collectSearchValues(request?.resolved, values);
  collectSearchValues(request?.args, values);
  collectSearchValues(justification, values);
  const terms = new Set();
  for (const value of values) {
    for (const match of String(value).toLowerCase().matchAll(/[\p{L}\p{N}_.:@/\\-]{3,}/gu)) {
      const term = match[0];
      if (term.length <= 256 && !STOP_WORDS.has(term)) terms.add(term);
      if (terms.size >= MAX_QUERY_TERMS) return terms;
    }
  }
  return terms;
}

function collectSearchValues(value, output, key = '', depth = 0) {
  if (depth > MAX_SEARCH_DEPTH) return;
  if (IGNORED_KEYS.test(key) || value === null || value === undefined) return;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    output.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, MAX_SEARCH_CHILDREN)) {
      collectSearchValues(item, output, '', depth + 1);
    }
    return;
  }
  if (typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value).slice(0, MAX_SEARCH_CHILDREN)) {
      collectSearchValues(childValue, output, childKey, depth + 1);
    }
  }
}

function relevanceScore(item, terms) {
  if (terms.size === 0) return 0;
  const searchable = `${item.tool ?? ''} ${item.status ?? ''} ${item.content}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (!searchable.includes(term)) continue;
    score += term.includes('/') || term.includes('\\') || term.includes('.') ? 3 : 1;
  }
  return score;
}

function takeBytes(value, maximum) {
  if (maximum <= 0) return '';
  const source = String(value);
  if (Buffer.byteLength(source, 'utf8') <= maximum) return source;
  let result = '';
  let resultBytes = 0;
  for (const character of source) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (resultBytes + characterBytes > maximum) break;
    result += character;
    resultBytes += characterBytes;
  }
  return result;
}
