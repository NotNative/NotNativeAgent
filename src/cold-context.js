// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { redactExtensionData, redactText } from './redaction.js';

const EVIDENCE_TYPES = new Set(['message', 'tool_request', 'tool_result', 'compaction', 'context_checkpoint']);
const MAX_HINTS = 3;
const MAX_SNIPPET = 240;
const CONTINUITY_CUES = new Set(['continue', 'earlier', 'previous', 'prior', 'resume']);
const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'are', 'been', 'before', 'can', 'could', 'does', 'for', 'from',
  'have', 'into', 'just', 'like', 'need', 'please', 'should', 'that', 'the', 'their', 'then', 'there', 'these',
  'they', 'this', 'those', 'through', 'want', 'what', 'when', 'where', 'which', 'with', 'would', 'you', 'your',
]);

export function buildColdEvidence(fullRecords, providerRecords, currentContent) {
  const hot = fingerprintCounts(providerRecords.filter(isEvidence));
  const cold = [];
  for (let index = 0; index < fullRecords.length; index += 1) {
    const record = fullRecords[index];
    if (!isEvidence(record)) continue;
    const key = recordFingerprint(record);
    const count = hot.get(key) ?? 0;
    if (count > 0) { hot.set(key, count - 1); continue; }
    cold.push({ index, record });
  }
  if (cold.length === 0) return null;
  const terms = queryTerms(currentContent);
  const hints = relevantHints(cold, terms, hasContinuityCue(currentContent));
  const types = typeCounts(cold);
  const turns = new Set(cold.map(({ record }) => turnId(record)).filter(Boolean));
  const fingerprint = createHash('sha256').update(JSON.stringify({
    records: cold.map(({ index, record }) => [index, recordFingerprint(record)]),
    hints: hints.map((item) => item.record_index),
  })).digest('hex');
  return Object.freeze({
    version: 1, available_records: cold.length, available_turns: turns.size,
    record_types: Object.freeze(types), hints: Object.freeze(hints), fingerprint,
  });
}

function relevantHints(cold, terms, continuity) {
  const ranked = cold.map(({ index, record }) => {
    const text = searchableText(record);
    return { index, record, text, score: relevance(text.toLowerCase(), terms) };
  }).filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || right.index - left.index)
    .slice(0, MAX_HINTS);
  if (continuity && ranked.length < MAX_HINTS) {
    const selected = new Set(ranked.map((item) => item.index));
    for (let offset = cold.length - 1; offset >= 0 && ranked.length < MAX_HINTS; offset -= 1) {
      const { index, record } = cold[offset];
      if (selected.has(index)) continue;
      ranked.push({ index, record, text: searchableText(record), score: 1 });
    }
  }
  return ranked.map(({ index, record, text, score }) => Object.freeze({
      record_index: index, type: String(record.type), turn_id: turnId(record),
      relevance: score, snippet: redactText(text).replace(/\s+/gu, ' ').trim().slice(0, MAX_SNIPPET),
    }));
}

function queryTerms(value) {
  return [...new Set(String(value ?? '').toLowerCase()
    .split(/[^\p{L}\p{N}_.:/-]+/u)
    .filter((term) => term.length > 2 && !STOP_WORDS.has(term) && !CONTINUITY_CUES.has(term)))]
    .sort((left, right) => right.length - left.length || left.localeCompare(right)).slice(0, 16);
}

function hasContinuityCue(value) {
  return String(value ?? '').toLowerCase().split(/[^\p{L}\p{N}_-]+/u)
    .some((term) => CONTINUITY_CUES.has(term));
}

function relevance(text, terms) {
  let score = 0;
  for (const term of terms) {
    let offset = 0; let count = 0;
    while (count < 4 && (offset = text.indexOf(term, offset)) >= 0) { count += 1; offset += term.length; }
    score += count * (term.length >= 8 ? 8 : term.length >= 5 ? 5 : 3);
  }
  return score;
}

function searchableText(record) {
  const safe = redactExtensionData(record);
  const values = [safe.type, safe.role, safe.content, safe.tool, safe.toolName, safe.target,
    safe.status, safe.outcome, safe.reason, safe.reason_code, safe.args, safe.arguments];
  return values.map((value) => typeof value === 'string' ? value : safeJson(value)).join('\n').slice(0, 16_384);
}

function typeCounts(cold) {
  const counts = new Map();
  for (const { record } of cold) counts.set(record.type, (counts.get(record.type) ?? 0) + 1);
  return Object.freeze(Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right))));
}

function fingerprintCounts(records) {
  const counts = new Map();
  for (const record of records) {
    const key = recordFingerprint(record);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function recordFingerprint(record) {
  return createHash('sha256').update(safeJson(record)).digest('hex');
}

function isEvidence(record) { return record && typeof record === 'object' && EVIDENCE_TYPES.has(record.type); }
function turnId(record) { return record.turn_id ?? record.turnId ?? null; }
function safeJson(value) { try { return JSON.stringify(value) ?? ''; } catch { return '[unserializable]'; } }
