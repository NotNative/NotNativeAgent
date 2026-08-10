// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';

export const CONTEXT_PRESSURE = Object.freeze({
  receipts: 0.25,
  checkpoint: 0.35,
  aggressive: 0.45,
  compact: 0.60,
});

export function pressureTier(estimatedTokens, effectiveInputTokens) {
  if (!positive(estimatedTokens) || !positive(effectiveInputTokens)) return 'none';
  const ratio = estimatedTokens / effectiveInputTokens;
  if (ratio >= CONTEXT_PRESSURE.compact) return 'compact';
  if (ratio >= CONTEXT_PRESSURE.aggressive) return 'aggressive';
  if (ratio >= CONTEXT_PRESSURE.checkpoint) return 'checkpoint';
  if (ratio >= CONTEXT_PRESSURE.receipts) return 'receipts';
  return 'none';
}

export function projectActiveTurn(records, options) {
  const tier = options.tier ?? 'none';
  if (tier === 'none' || !options.turnId) return unchanged(records, tier);
  const active = records.map((item, index) => ({ item, index }))
    .filter((entry) => recordTurnId(entry.item) === options.turnId);
  if (active.length === 0) return unchanged(records, tier);
  const steps = orderedSteps(active);
  const keepCount = tier === 'receipts' ? 3 : tier === 'checkpoint' ? 2 : 1;
  const hotSteps = new Set(steps.slice(-keepCount));
  const cold = new Set(active.filter((entry) => isCold(entry.item, hotSteps)).map((entry) => entry.index));
  if (cold.size === 0) return unchanged(records, tier);
  const checkpoint = createActiveCheckpoint(records, cold, options, tier);
  const projected = tier === 'receipts'
    ? receiptProjection(records, cold)
    : checkpointProjection(records, cold, checkpoint);
  return Object.freeze({
    records: Object.freeze(projected), checkpoint, tier,
    coldRecords: cold.size, retainedActiveSteps: hotSteps.size,
    sourceFingerprint: checkpoint.sourceFingerprint,
  });
}

function receiptProjection(records, cold) {
  return records.map((item, index) => {
    if (!cold.has(index)) return item;
    if (item.type === 'tool_result') return toolResultReceipt(item);
    if (item.type === 'tool_request') return toolRequestReceipt(item);
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
  const requests = new Map(selected.filter((item) => item.type === 'tool_request')
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
      tool: item.toolName ?? request?.toolName ?? 'unknown', status: item.status ?? 'unknown',
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

function renderCheckpoint(item) {
  const lines = [
    'NNA active-turn checkpoint. This is a deterministic working-context projection; full attributed records remain in the durable session journal.',
    `Authenticated objective: ${boundedHeadTail(item.operator, 2_048) || '(not recorded)'}`,
  ];
  if (item.progress.length > 0) lines.push(`Recent model-reported progress:\n- ${item.progress.join('\n- ')}`);
  if (item.tools.length > 0) {
    lines.push(`Settled tool receipts:\n${item.tools.map((entry) => {
      const target = entry.target ? ` ${entry.target}` : '';
      const excerpt = entry.excerpt ? `: ${entry.excerpt}` : '';
      return `- ${entry.status} ${entry.tool}${target} [${entry.requestId ?? 'no-id'}]${excerpt}`;
    }).join('\n')}`);
  }
  lines.push('Use session.search_history and session.read_history when complete omitted evidence is needed.');
  return boundedHeadTail(lines.join('\n\n'), item.tier === 'aggressive' ? 16_384 : 24_576);
}

function toolResultReceipt(item) {
  const excerpt = boundedHeadTail(item.content ?? '', 1_024);
  return {
    ...item,
    content: `${excerpt}${excerpt ? '\n' : ''}[Settled tool output compressed for active context; full output remains in the durable session journal.]`,
    metadata: { ...boundedMetadata(item.metadata), compacted: true, reason: 'active_pressure_receipt', ledgerRef: ledgerRef(item) },
  };
}

function toolRequestReceipt(item) {
  return {
    ...item,
    args: { compacted: true, target: requestTarget(item), ledgerRef: ledgerRef(item) },
    pressureCompacted: true,
  };
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
  if (Buffer.byteLength(text, 'utf8') <= limit) return text;
  const edge = Math.max(1, Math.floor(limit / 2));
  return `${Buffer.from(text, 'utf8').subarray(0, edge).toString('utf8')}\n...[checkpoint excerpt]...\n${Buffer.from(text, 'utf8').subarray(-edge).toString('utf8')}`;
}

function fingerprint(records) {
  return createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

function unchanged(records, tier) {
  return Object.freeze({ records, checkpoint: null, tier, coldRecords: 0, retainedActiveSteps: 0, sourceFingerprint: null });
}
