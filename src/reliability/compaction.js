// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import {
  bounded, boundedHeadTail, hierarchicalContinuationArtifact, renderContinuation,
  renderHandoff, terseTail,
} from './continuation-artifact.js';
import { retainedRecordsFingerprint } from './long-horizon-context.js';
import { compactToolRequest, createToolContextReceipt } from '../tools/context-receipt.js';

export { attachTaskCheckpoint, enrichCompactionFact, enrichHandoffFact } from './continuation-artifact.js';

const DEFAULT_PROTECTED_COMPLETED_TURNS = 5;
const RECORD_BUDGET_RATIO = 0.55;
const EMERGENCY_THRESHOLD_RATIO = 0.65;
const SUMMARY_BUDGET_RATIO = 0.35;
const MINIMUM_SUMMARY_BYTES = 1_024;
const COLD_MESSAGE_BYTES = 32_768;
export function compactTranscript(transcript, maxBytes, options = {}) {
  const source = latestCompactionProjection(transcript);
  const budget = Math.floor(maxBytes * RECORD_BUDGET_RATIO);
  let selected = selectRecentRecords(source, budget, options);
  let policy = 'protected_recency_v1';
  if (options.requireProgress && source.length > 2 && selected.length === source.length) {
    const originalBytes = source.reduce((sum, item) => sum + recordBytes(item), 0);
    const adaptiveBudget = Math.max(16_384, Math.min(budget, Math.floor(originalBytes * RECORD_BUDGET_RATIO)));
    selected = selectRecentRecords(source, adaptiveBudget, {
      ...options, protectedCompletedTurns: 0,
    });
    policy = 'adaptive_recent_history_v2';
  }
  let bytes = selected.reduce((sum, entry) => sum + recordBytes(entry.item), 0);
  if (bytes > maxBytes * EMERGENCY_THRESHOLD_RATIO) {
    selected = emergencyContinuationRecords(source, maxBytes, selected.metrics);
    bytes = selected.reduce((sum, entry) => sum + recordBytes(entry.item), 0);
    policy = 'hierarchical_continuation_v1';
  }
  const omitted = Math.max(0, source.length - selected.length);
  const continuation = hierarchicalContinuationArtifact(source, omitted);
  const summaryBudget = Math.min(maxBytes, Math.max(MINIMUM_SUMMARY_BYTES, Math.floor(maxBytes * SUMMARY_BUDGET_RATIO)));
  const summary = renderContinuation(continuation, summaryBudget);
  const fact = Object.freeze({
    type: 'compaction', version: 2, omitted,
    sourceFingerprint: fingerprint(source),
    continuation,
    summary,
    retainedRecords: Object.freeze(selected.map((entry) => Object.freeze(entry.item))),
    projection: Object.freeze({
      policy,
      protectedCompletedTurns: selected.metrics.protectedCompletedTurns,
      protectedTurnCount: selected.metrics.protectedTurnCount,
      protectedRecordCount: selected.metrics.protectedRecordCount,
      payloadCompactedRecords: selected.metrics.payloadCompactedRecords,
      semanticReceiptRecords: selected.metrics.semanticReceiptRecords,
      oversizedProtectedRecords: selected.metrics.oversizedProtectedRecords,
      supersededRecords: selected.metrics.supersededRecords,
      originalBytes: selected.metrics.originalBytes,
      projectedBytes: bytes + Buffer.byteLength(summary, 'utf8'),
      retainedFingerprint: retainedRecordsFingerprint(selected.map((entry) => entry.item)),
      hierarchyChunks: continuation.hierarchyChunks ?? 1,
      summaryBudgetBytes: summaryBudget,
    }),
  });
  return Object.freeze({ records: fact.retainedRecords, fact });
}

function latestCompactionProjection(transcript) {
  let latest = -1;
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (transcript[index]?.type === 'compaction') { latest = index; break; }
  }
  if (latest < 0) return transcript;
  const checkpoint = transcript[latest];
  if (!Array.isArray(checkpoint.retainedRecords)) return transcript;
  return [checkpoint, ...checkpoint.retainedRecords, ...transcript.slice(latest + 1)];
}

export function createHandoffFact(transcript) {
  const source = hierarchicalContinuationArtifact(transcript, transcript.length);
  const continuation = Object.freeze({
    schema: 'nna.handoff.v1',
    objective: boundedHeadTail(source.objective, 1_024),
    decisions: Object.freeze(terseTail(source.recentDirectives, 4, 2_048)),
    completedWork: Object.freeze(terseTail(source.completedWork, 4, 2_048)),
    verifiedState: Object.freeze(terseTail([
      ...source.changedFiles.map((entry) => `${entry.operation} ${entry.path} (${entry.status})`),
      ...source.verifiedFacts,
    ], 6, 3_072)),
    blockers: Object.freeze(terseTail(source.unresolvedTools.map((entry) => `${entry.tool} (${entry.id})`), 4, 2_048)),
    nextActions: Object.freeze([]),
    latestOutcome: bounded(source.latestOutcome, 64),
    omittedRecords: transcript.length,
  });
  const summary = renderHandoff(continuation);
  return Object.freeze({
    type: 'compaction', version: 3, omitted: transcript.length,
    sourceFingerprint: fingerprint(transcript), continuation, summary,
    retainedRecords: Object.freeze([]),
    projection: Object.freeze({
      policy: 'terse_handoff_v1', protectedCompletedTurns: 0,
      protectedTurnCount: 0, protectedRecordCount: 0,
      payloadCompactedRecords: 0, oversizedProtectedRecords: 0,
      semanticReceiptRecords: 0,
      supersededRecords: 0,
      originalBytes: transcript.reduce((sum, item) => sum + recordBytes(item), 0),
      projectedBytes: Buffer.byteLength(summary, 'utf8'),
    }),
  });
}

function emergencyContinuationRecords(transcript, maxBytes, priorMetrics) {
  const target = Math.max(1_024, Math.floor(maxBytes * 0.2));
  const messages = transcript.map((item, index) => ({ item, index }))
    .filter((entry) => entry.item.type === 'message');
  const latestUser = [...messages].reverse().find((entry) => entry.item.role === 'user');
  const latestAssistant = [...messages].reverse().find((entry) => entry.item.role === 'assistant');
  const candidates = [latestUser, latestAssistant].filter(Boolean)
    .filter((entry, index, items) => items.findIndex((item) => item.index === entry.index) === index)
    .sort((left, right) => left.index - right.index);
  const perRecord = Math.max(256, Math.floor(target / Math.max(1, candidates.length)) - 256);
  const retained = candidates.map((entry) => ({
    index: entry.index, protected: true, turnKey: null,
    item: {
      ...entry.item,
      content: `${boundedHeadTail(entry.item.content ?? '', perRecord)}\n[Recent message reduced into an emergency continuation checkpoint; the complete text remains in the durable session ledger.]`,
      metadata: {
        ...boundedMetadata(entry.item.metadata), compacted: true,
        reason: 'hierarchical_continuation_fallback', ledgerRef: ledgerReference(entry.item),
      },
    },
  }));
  retained.metrics = Object.freeze({
    ...priorMetrics,
    protectedRecordCount: retained.length,
    payloadCompactedRecords: (priorMetrics?.payloadCompactedRecords ?? 0) + retained.length,
    oversizedProtectedRecords: (priorMetrics?.oversizedProtectedRecords ?? 0) + retained.length,
  });
  return retained;
}

function selectRecentRecords(transcript, budget, options) {
  const protection = protectedRecency(transcript, options);
  const projection = supersedeColdToolResults(transcript, protection.indexes);
  const turns = turnEntries(projection.records);
  const requests = new Map(projection.records.filter((item) => item.type === 'tool_request').map((item) => [item.providerCallId, item]));
  const normalized = projection.records.map((item, index) => ({
    index, item: compactRecord(item, budget, protection.indexes.has(index), requests.get(item.providerCallId)),
    protected: protection.indexes.has(index),
    turnKey: turns[index].turnKey,
  }));
  const requestIndexes = new Map(); const resultIndexes = new Map();
  for (const entry of normalized) {
    if (entry.item.type === 'tool_request') requestIndexes.set(entry.item.providerCallId, entry.index);
    if (entry.item.type === 'tool_result') resultIndexes.set(entry.item.providerCallId, entry.index);
  }
  const consumed = new Set(); const units = [];
  for (const entry of normalized) {
    if (consumed.has(entry.index)) continue;
    if (entry.item.type === 'tool_request' && resultIndexes.has(entry.item.providerCallId)) {
      const resultIndex = resultIndexes.get(entry.item.providerCallId);
      const result = normalized[resultIndex];
      consumed.add(entry.index); consumed.add(resultIndex);
      units.push({ entries: [entry, result].sort((a, b) => a.index - b.index), priority: Math.max(entry.index, resultIndex) });
      continue;
    }
    if (entry.item.type === 'tool_result' && requestIndexes.has(entry.item.providerCallId)) continue;
    consumed.add(entry.index); units.push({ entries: [entry], priority: entry.index });
  }
  const latestUser = [...normalized].reverse().find((entry) => entry.item.type === 'message' && entry.item.role === 'user');
  const selected = new Map(); let bytes = 0;
  const add = (unit, required = false) => {
    const size = unit.entries.reduce((sum, entry) => sum + recordBytes(entry.item), 0);
    if (!required && bytes + size > budget) return false;
    for (const entry of unit.entries) selected.set(entry.index, entry);
    bytes += size; return true;
  };
  for (const unit of units.filter((candidate) => candidate.entries.some((entry) => entry.protected))) add(unit, true);
  if (latestUser && !selected.has(latestUser.index)) {
    add(units.find((unit) => unit.entries.some((entry) => entry.index === latestUser.index)), true);
  }
  for (const unit of [...units].sort((a, b) => b.priority - a.priority)) {
    if (unit.entries.some((entry) => selected.has(entry.index))) continue;
    add(unit);
  }
  const retained = shrinkOversizedProtectedRecords([...selected.values()].sort((a, b) => a.index - b.index), budget);
  retained.metrics = Object.freeze({
    protectedCompletedTurns: protection.completedTurnCount,
    protectedTurnCount: protection.turnKeys.size,
    protectedRecordCount: retained.filter((entry) => entry.protected).length,
    payloadCompactedRecords: retained.filter((entry) => entry.item.metadata?.compacted === true).length,
    semanticReceiptRecords: retained.filter((entry) => entry.item.metadata?.reason === 'semantic_tool_receipt').length,
    oversizedProtectedRecords: retained.filter((entry) => entry.item.metadata?.reason === 'oversized_protected_record').length
      + (retained.oversizedRemoved ?? 0),
    supersededRecords: projection.superseded,
    originalBytes: transcript.reduce((sum, item) => sum + recordBytes(item), 0),
  });
  return retained;
}

function supersedeColdToolResults(transcript, protectedIndexes) {
  const requests = new Map();
  for (const item of transcript) {
    if (item.type === 'tool_request') requests.set(item.providerCallId, item);
  }
  const latest = new Map();
  const keys = new Map();
  for (let index = 0; index < transcript.length; index += 1) {
    const item = transcript[index];
    if (item.type !== 'tool_result' || item.status !== 'succeeded') continue;
    const request = requests.get(item.providerCallId);
    const key = supersessionKey(request);
    if (!key) continue;
    keys.set(index, key); latest.set(key, index);
  }
  let superseded = 0;
  const records = transcript.map((item, index) => {
    if (protectedIndexes.has(index)) return item;
    const key = keys.get(index);
    if (!key || latest.get(key) === index) return item;
    const notice = '[Older successful tool output superseded by a newer result for the same target; full output remains in the session journal.]';
    if (Buffer.byteLength(String(item.content ?? ''), 'utf8') - Buffer.byteLength(notice, 'utf8') < 512) return item;
    superseded += 1;
    return {
      ...item, content: notice,
      metadata: { compacted: true, reason: 'superseded_result', ledgerRef: ledgerReference(item) },
    };
  });
  return Object.freeze({ records, superseded });
}

function supersessionKey(request) {
  if (!request || !request.args || typeof request.args !== 'object') return null;
  const args = request.args;
  switch (request.toolName) {
    case 'fs.read_text': return keyed(request.toolName, [args.path]);
    case 'fs.read_lines': return keyed(request.toolName, [args.path, args.start_line, args.end_line]);
    case 'fs.list_directory': return keyed(request.toolName, [args.path, args.depth]);
    case 'fs.glob': return keyed(request.toolName, [args.path, args.pattern]);
    case 'fs.search_text': return keyed(request.toolName, [args.path, args.query, args.glob]);
    case 'code.diagnostics': return keyed(request.toolName, [args.path]);
    case 'web.fetch': return keyed(request.toolName, [args.url]);
    default: return null;
  }
}

function keyed(name, values) {
  if (values[0] === undefined || values[0] === null || values[0] === '') return null;
  return `${name}:${JSON.stringify(values)}`;
}

function compactRecord(item, budget, protectedRecord = false, request = null) {
  if (item.type === 'tool_result') {
    const cap = protectedRecord
      ? Math.max(16_384, Math.min(131_072, Math.floor(budget / 4)))
      : Math.max(2_048, Math.min(16_384, Math.floor(budget / 8)));
    if (protectedRecord && recordBytes(item) <= cap) return { ...item };
    if (!protectedRecord) return createToolContextReceipt(item, request);
    const content = boundedHeadTail(item.content ?? '', cap);
    const truncated = content !== (item.content ?? '');
    return {
      ...item,
      content: truncated ? `${content}\n[Tool output compacted; the complete result remains in the durable session ledger.]` : content,
      metadata: truncated
        ? {
          ...boundedMetadata(item.metadata), compacted: true,
          reason: protectedRecord ? 'oversized_protected_payload' : 'tool_payload',
          ledgerRef: ledgerReference(item),
        }
        : boundedMetadata(item.metadata),
    };
  }
  if (item.type === 'tool_request' && !protectedRecord) return compactToolRequest(item);
  if (item.type === 'message') {
    if (protectedRecord) return { ...item };
    const content = boundedHeadTail(item.content ?? '', COLD_MESSAGE_BYTES);
    return content === (item.content ?? '') ? { ...item } : {
      ...item, content,
      metadata: { ...boundedMetadata(item.metadata), compacted: true, reason: 'cold_message' },
    };
  }
  if (item.type === 'compaction') {
    const { retainedRecords: _retainedRecords, ...checkpoint } = item;
    return checkpoint;
  }
  if (typeof item.content !== 'string') return item;
  const content = boundedHeadTail(item.content, COLD_MESSAGE_BYTES);
  return content === item.content ? item : {
    ...item, content,
    metadata: { ...boundedMetadata(item.metadata), compacted: true, reason: 'unknown_record_content' },
  };
}

function protectedRecency(transcript, options) {
  const completedLimit = Number.isInteger(options.protectedCompletedTurns)
    ? Math.max(0, options.protectedCompletedTurns) : DEFAULT_PROTECTED_COMPLETED_TURNS;
  const entries = turnEntries(transcript);
  const ordered = []; const seen = new Set();
  for (const entry of entries) {
    if (entry.turnKey && !seen.has(entry.turnKey)) { seen.add(entry.turnKey); ordered.push(entry.turnKey); }
  }
  const explicitActive = options.activeTurnId ? `id:${options.activeTurnId}` : null;
  const active = explicitActive && ordered.includes(explicitActive) ? explicitActive : null;
  const completed = ordered.filter((key) => key !== active).slice(-completedLimit);
  const turnKeys = new Set([...completed, ...(active ? [active] : [])]);
  const activeStepLimit = Number.isInteger(options.protectedActiveSteps)
    ? Math.max(1, options.protectedActiveSteps) : null;
  const activeSteps = active && activeStepLimit
    ? unique(entries.filter((entry) => entry.turnKey === active).map((entry) => entry.stepKey).filter(Boolean)).slice(-activeStepLimit)
    : [];
  const activeStepKeys = new Set(activeSteps);
  const indexes = new Set(entries.filter((entry) => {
    if (completed.includes(entry.turnKey)) return true;
    if (entry.turnKey !== active) return false;
    if (!activeStepLimit) return true;
    if (entry.item.type === 'message' && entry.item.role === 'user') return true;
    if (entry.item.type === 'compaction' || entry.item.type === 'context_checkpoint') return true;
    return Boolean(entry.stepKey && activeStepKeys.has(entry.stepKey));
  }).map((entry) => entry.index));
  return Object.freeze({ indexes, turnKeys, completedTurnCount: completed.length });
}

function turnEntries(transcript) {
  let inferred = null;
  return transcript.map((item, index) => {
    const explicit = item.turnId ?? item.turn_id ?? null;
    const step = item.stepId ?? item.step_id ?? null;
    if (explicit) return { index, item, turnKey: `id:${explicit}`, stepKey: step ? `id:${step}` : null };
    if (item.type === 'message' && item.role === 'user') inferred = `legacy:${index}`;
    return { index, item, turnKey: inferred, stepKey: step ? `id:${step}` : null };
  });
}

function unique(values) { return [...new Set(values)]; }

function shrinkOversizedProtectedRecords(entries, budget) {
  let bytes = entries.reduce((sum, entry) => sum + recordBytes(entry.item), 0);
  if (bytes <= budget) return entries;
  const candidates = entries.filter((entry) => entry.protected && entry.item.type === 'message')
    .sort((left, right) => {
      const roleOrder = Number(left.item.role === 'user') - Number(right.item.role === 'user');
      return roleOrder || left.index - right.index;
    });
  const cap = Math.max(512, Math.floor(budget / Math.max(5, candidates.length)));
  for (const entry of candidates) {
    if (bytes <= budget) break;
    if (Buffer.byteLength(entry.item.content ?? '', 'utf8') <= cap) continue;
    const before = recordBytes(entry.item);
    entry.item = {
      ...entry.item,
      content: `${boundedHeadTail(entry.item.content ?? '', cap)}\n[Oversized recent message compacted for provider admission; the complete text remains in the durable session ledger.]`,
      metadata: {
        ...boundedMetadata(entry.item.metadata), compacted: true,
        reason: 'oversized_protected_record', ledgerRef: ledgerReference(entry.item),
      },
    };
    bytes -= before - recordBytes(entry.item);
  }
  if (bytes <= budget) return entries;
  const lastAssistant = new Map();
  for (const entry of entries) {
    if (entry.protected && entry.item.type === 'message' && entry.item.role === 'assistant') {
      lastAssistant.set(entry.turnKey, entry.index);
    }
  }
  const removed = new Set();
  for (const entry of candidates) {
    if (bytes <= budget) break;
    if (entry.item.role !== 'assistant' || lastAssistant.get(entry.turnKey) === entry.index) continue;
    bytes -= recordBytes(entry.item);
    removed.add(entry.index);
  }
  const retained = entries.filter((entry) => !removed.has(entry.index));
  retained.oversizedRemoved = removed.size;
  return retained;
}

function ledgerReference(item) {
  return item.requestId ?? item.providerCallId ?? item.turnId ?? item.turn_id ?? null;
}

function boundedMetadata(value) {
  if (value === null || value === undefined) return value ?? null;
  try {
    const text = JSON.stringify(value);
    return Buffer.byteLength(text, 'utf8') <= 4_096 ? value : { compacted: true };
  } catch { return { compacted: true }; }
}

function recordBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function fingerprint(transcript) {
  const hash = createHash('sha256');
  for (const item of transcript.slice(-4096)) hash.update(JSON.stringify(item));
  return hash.digest('hex');
}
