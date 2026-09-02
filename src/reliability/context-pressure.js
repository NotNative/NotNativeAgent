// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { toolLifecycleStatus } from '../tools/tool-result-contract.js';
import { projectDuplicateToolResults } from './duplicate-results.js';

export const CONTEXT_PRESSURE = Object.freeze({
  receipts: 0.40,
  checkpoint: 0.55,
  aggressive: 0.70,
  compact: 0.75,
});
// Why: active filesystem evidence needs enough local context to prevent avoidable repeat reads;
// byte-only telemetry below measures whether this budget improves the intended outcome.
const ACTIVE_RECEIPT_BYTES = Object.freeze({ filesystem: 4096, search: 2048, other: 1024 });
const READ_TOOLS = new Set(['fs.read', 'fs.read_lines', 'fs.read_text']);

export function contextPressurePolicy(
  compression = CONTEXT_PRESSURE.receipts,
  checkpoint = CONTEXT_PRESSURE.checkpoint,
  aggressive = CONTEXT_PRESSURE.aggressive,
  compact = CONTEXT_PRESSURE.compact,
) {
  return Object.freeze({
    receipts: compression,
    checkpoint,
    aggressive,
    compact,
  });
}

export function pressureTier(estimatedTokens, effectiveInputTokens, policy = CONTEXT_PRESSURE) {
  if (!positive(estimatedTokens) || !positive(effectiveInputTokens)) return 'none';
  const ratio = estimatedTokens / effectiveInputTokens;
  if (ratio >= policy.compact) return 'compact';
  if (ratio >= policy.aggressive) return 'aggressive';
  if (ratio >= policy.checkpoint) return 'checkpoint';
  if (ratio >= policy.receipts) return 'receipts';
  return 'none';
}

export function projectActiveTurn(records, options) {
  const tier = options.tier ?? 'none';
  if (tier === 'none' || !options.turnId) return unchanged(records, tier, options.turnId);
  const active = records.map((item, index) => ({ item, index }))
    .filter((entry) => recordTurnId(entry.item) === options.turnId);
  if (active.length === 0) return unchanged(records, tier, options.turnId);
  const steps = orderedSteps(active);
  const keepCount = ({ receipts: 3, checkpoint: 2 }[tier] ?? 1);
  const hotSteps = new Set(steps.slice(-keepCount));
  const cold = new Set(active.filter((entry) => isCold(entry.item, hotSteps)).map((entry) => entry.index));
  if (cold.size === 0) return unchanged(records, tier, options.turnId);
  const checkpoint = createActiveCheckpoint(records, cold, options, tier);
  const protectedIndexes = new Set(records.map((_item, index) => index).filter((index) => !cold.has(index)));
  const duplicates = tier === 'receipts'
    ? projectDuplicateToolResults(records, protectedIndexes)
    : { records, duplicateRecords: 0, bytesSaved: 0 };
  const projected = tier === 'receipts'
    ? receiptProjection(duplicates.records, cold)
    : checkpointProjection(records, cold, checkpoint);
  const evidenceRetention = measureEvidenceRetention(records, projected, options.turnId);
  return Object.freeze({
    records: Object.freeze(projected), checkpoint, tier,
    coldRecords: cold.size, retainedActiveSteps: hotSteps.size,
    duplicateResultRecords: duplicates.duplicateRecords,
    duplicateResultBytesSaved: duplicates.bytesSaved,
    sourceFingerprint: checkpoint.sourceFingerprint, evidenceRetention,
  });
}

function receiptProjection(records, cold) {
  return records.map((item, index) => {
    if (!cold.has(index)) return item;
    if (item.type === 'tool_result') {
      return item.metadata?.reason === 'duplicate_result' ? item : toolResultReceipt(item);
    }
    // Invariant: a retained native tool exchange must replay the exact arguments that were
    // originally accepted. Receipt metadata belongs on the result; rewriting request args
    // teaches the provider a shape that the tool schema will correctly reject on reuse.
    if (item.type === 'tool_request') return item;
    if (item.type === 'message' && item.role === 'assistant') {
      return { ...item, content: boundedHeadTail(item.content ?? '', 4_096), pressureCompacted: true };
    }
    return item;
  });
}

function checkpointProjection(records, cold, checkpoint) {
  const projected = []; let inserted = false;
  for (let index = 0; index < records.length; index += 1) {
    if (!cold.has(index)) { projected.push(records[index]); continue; }
    if (!inserted) { projected.push(checkpoint); inserted = true; }
  }
  return projected;
}

function createActiveCheckpoint(records, cold, options, tier) {
  const selected = [...cold].sort((a, b) => a - b).map((index) => records[index]);
  const requests = new Map(selected.filter((item) => item.type === 'tool_request' && item.providerCallId)
    .map((item) => [item.providerCallId, item]));
  const operator = records.filter((item) => recordTurnId(item) === options.turnId
    && item.type === 'message' && item.role === 'user').at(0);
  const progress = selected.filter((item) => item.type === 'message' && item.role === 'assistant')
    .map((item) => boundedHeadTail(item.content ?? '', 1_024)).filter(Boolean).slice(-6);
  const tools = selected.filter((item) => item.type === 'tool_result').slice(-20).map((item) => {
    const request = requests.get(item.providerCallId);
    const target = requestTarget(request);
    const excerpt = boundedHeadTail(item.content ?? '', 768).replace(/\s+/gu, ' ').trim();
    return Object.freeze({
      tool: item.toolName ?? request?.toolName ?? 'unknown', toolLifecycleStatus: toolLifecycleStatus(item) ?? 'unknown',
      requestId: item.requestId ?? item.providerCallId ?? null, target,
      excerpt: excerpt || null,
    });
  });
  const sourceFingerprint = fingerprint(selected);
  const summary = renderCheckpoint({ tier, operator: operator?.content ?? '', progress, tools });
  return Object.freeze({
    type: 'context_checkpoint', version: 1, turnId: options.turnId,
    stepId: options.stepId ?? null, tier, sourceFingerprint,
    omittedRecords: selected.length, summary,
    progress: Object.freeze(progress), tools: Object.freeze(tools),
    createdAt: new Date().toISOString(),
  });
}

function renderCheckpoint(checkpointData) {
  const lines = [
    'NNA active-turn checkpoint. This is a deterministic working-context projection; full attributed records remain in the durable session journal.',
    `Authenticated objective: ${boundedHeadTail(checkpointData.operator, 2_048) || '(not recorded)'}`,
  ];
  if (checkpointData.progress.length > 0) lines.push(`Recent model-reported progress:\n- ${checkpointData.progress.join('\n- ')}`);
  if (checkpointData.tools.length > 0) {
    lines.push(`Settled tool receipts:\n${checkpointData.tools.map((entry) => {
      const target = entry.target ? ` ${entry.target}` : '';
      const excerpt = entry.excerpt ? `: ${entry.excerpt}` : '';
      return `- ${entry.toolLifecycleStatus} ${entry.tool}${target} [${entry.requestId ?? 'no-id'}]${excerpt}`;
    }).join('\n')}`);
  }
  lines.push('Use session.search_history and session.read_history when complete omitted evidence is needed.');
  return boundedHeadTail(lines.join('\n\n'), checkpointData.tier === 'aggressive' ? 16_384 : 24_576);
}

function toolResultReceipt(item) {
  const budget = ACTIVE_RECEIPT_BYTES[receiptCategory(item.toolName)];
  const excerpt = boundedHeadTail(item.content ?? '', budget);
  return {
    ...item,
    content: `${excerpt}${excerpt ? '\n' : ''}[Settled tool output compressed for active context; full output remains in the durable session journal.]`,
    metadata: { ...boundedMetadata(item.metadata), compacted: true, reason: 'active_pressure_receipt', ledgerRef: ledgerRef(item) },
  };
}

function receiptCategory(name = '') {
  if (/^(?:fs\.|code\.)/u.test(name)) {
    return /(?:search|glob|list|diagnostic)/u.test(name) ? 'search' : 'filesystem';
  }
  return 'other';
}

function measureEvidenceRetention(source, projected, turnId) {
  const sourceResults = source.filter((item) => isTurnRecord(item, turnId) && item.type === 'tool_result');
  const projectedResults = projected.filter((item) => isTurnRecord(item, turnId) && item.type === 'tool_result');
  const checkpoints = projected.filter((item) => isTurnRecord(item, turnId) && item.type === 'context_checkpoint');
  return Object.freeze({
    sourceToolResultBytes: contentBytes(sourceResults),
    projectedToolResultBytes: contentBytes(projectedResults),
    checkpointBytes: contentBytes(checkpoints),
    repeatedReadRequests: repeatedReadRequests(source, turnId),
  });
}

function contentBytes(records) {
  return records.reduce((total, item) => {
    return total + Buffer.byteLength(String(item.content ?? item.summary ?? ''), 'utf8');
  }, 0);
}

function repeatedReadRequests(records, turnId) {
  const seen = new Set(); let repeated = 0;
  for (const item of records) {
    if (!isTurnRecord(item, turnId) || item.type !== 'tool_request' || !READ_TOOLS.has(item.toolName)) continue;
    const identity = JSON.stringify({ tool: item.toolName, args: item.args ?? {} });
    if (seen.has(identity)) repeated += 1;
    else seen.add(identity);
  }
  return repeated;
}

function isCold(item, hotSteps) {
  if (item.type === 'message' && item.role === 'user') return false;
  if (item.type === 'context_checkpoint' || item.type === 'compaction') return false;
  const step = recordStepId(item);
  return !step || !hotSteps.has(step);
}

function orderedSteps(entries) {
  const steps = [];
  for (const { item } of entries) {
    const step = recordStepId(item);
    if (step && !steps.includes(step)) steps.push(step);
  }
  return steps;
}

function requestTarget(item) {
  const args = item?.args;
  if (!args || typeof args !== 'object') return null;
  const key = ['path', 'target', 'source', 'destination', 'url', 'query', 'executable', 'script']
    .find((candidate) => typeof args[candidate] === 'string' && args[candidate]);
  return key ? boundedHeadTail(`${key}=${args[key]}`, 512) : null;
}

function ledgerRef(item) {
  return item.requestId ?? item.providerCallId ?? item.turnId ?? null;
}

function recordTurnId(item) { return item.turnId ?? item.turn_id ?? null; }
function recordStepId(item) { return item.stepId ?? item.step_id ?? null; }
function positive(value) { return Number.isFinite(value) && value > 0; }

function boundedMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8') <= 2_048 ? value : {}; }
  catch { return {}; }
}

function boundedHeadTail(value, limit) {
  const text = String(value ?? '');
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.byteLength <= limit) return text;
  const edge = Math.max(1, Math.floor(limit / 2));
  let headEnd = edge;
  while (headEnd > 0 && (encoded[headEnd] & 0xc0) === 0x80) headEnd -= 1;
  let tailStart = encoded.byteLength - edge;
  while (tailStart < encoded.byteLength && (encoded[tailStart] & 0xc0) === 0x80) tailStart += 1;
  return `${encoded.subarray(0, headEnd).toString('utf8')}\n...[checkpoint excerpt]...\n${encoded.subarray(tailStart).toString('utf8')}`;
}

function fingerprint(records) {
  return createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

function unchanged(records, tier, turnId) {
  return Object.freeze({
    records, checkpoint: null, tier, coldRecords: 0, retainedActiveSteps: 0,
    duplicateResultRecords: 0, duplicateResultBytesSaved: 0, sourceFingerprint: null,
    evidenceRetention: measureEvidenceRetention(records, records, turnId),
  });
}

function isTurnRecord(item, turnId) { return !turnId || recordTurnId(item) === turnId; }
