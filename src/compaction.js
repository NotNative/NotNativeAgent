// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { ContractError } from './ids.js';
import { retainedRecordsFingerprint } from './long-horizon-context.js';
import { compactToolRequest, createToolContextReceipt } from './tool-context-receipt.js';

const DEFAULT_PROTECTED_COMPLETED_TURNS = 5;
export function compactTranscript(transcript, maxBytes, options = {}) {
  const source = latestCompactionProjection(transcript);
  const budget = Math.floor(maxBytes * 0.55);
  let selected = selectRecentRecords(source, budget, options);
  let policy = 'protected_recency_v1';
  if (options.requireProgress && source.length > 2 && selected.length === source.length) {
    const originalBytes = source.reduce((sum, item) => sum + recordBytes(item), 0);
    const adaptiveBudget = Math.max(16_384, Math.min(budget, Math.floor(originalBytes * 0.55)));
    selected = selectRecentRecords(source, adaptiveBudget, {
      ...options, protectedCompletedTurns: 0,
    });
    policy = 'adaptive_recent_history_v2';
  }
  const bytes = selected.reduce((sum, entry) => sum + recordBytes(entry.item), 0);
  if (bytes > maxBytes * 0.65) {
    throw new ContractError(
      'compaction_insufficient',
      'mandatory context still exceeds the provider budget; reduce the request or attachments, clear the conversation, or select a model with a larger context limit',
    );
  }
  const omitted = Math.max(0, source.length - selected.length);
  const continuation = continuationArtifact(source, omitted);
  const fact = Object.freeze({
    type: 'compaction', version: 2, omitted,
    sourceFingerprint: fingerprint(source),
    continuation,
    summary: renderContinuation(continuation),
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
      projectedBytes: bytes,
      retainedFingerprint: retainedRecordsFingerprint(selected.map((entry) => entry.item)),
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
  const source = continuationArtifact(transcript, transcript.length);
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
    return { ...item, content: boundedHeadTail(item.content ?? '', 32_768) };
  }
  if (item.type === 'compaction') {
    const { retainedRecords: _retainedRecords, ...checkpoint } = item;
    return checkpoint;
  }
  return item;
}

function protectedRecency(transcript, options) {
  const completedLimit = Number.isInteger(options.protectedCompletedTurns)
    ? Math.max(0, options.protectedCompletedTurns) : DEFAULT_PROTECTED_COMPLETED_TURNS;
  const entries = turnEntries(transcript);
  const ordered = [];
  for (const entry of entries) {
    if (entry.turnKey && !ordered.includes(entry.turnKey)) ordered.push(entry.turnKey);
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

function continuationArtifact(transcript, omitted) {
  const userMessages = transcript.filter((item) => item.type === 'message' && item.role === 'user');
  const objective = userMessages.at(-1);
  const objectiveIndex = objective ? transcript.lastIndexOf(objective) : -1;
  const currentRecords = objectiveIndex >= 0 ? transcript.slice(objectiveIndex + 1) : transcript;
  const currentAssistantMessages = currentRecords.filter((item) => item.type === 'message' && item.role === 'assistant');
  const assistantMessages = currentAssistantMessages.length > 0
    ? currentAssistantMessages
    : transcript.filter((item) => item.type === 'message' && item.role === 'assistant');
  const results = new Map(transcript.filter((item) => item.type === 'tool_result')
    .map((item) => [item.providerCallId, item]));
  const allToolRequests = transcript.filter((item) => item.type === 'tool_request');
  const toolRequests = currentRecords.filter((item) => item.type === 'tool_request');
  const changedFiles = [];
  for (const item of allToolRequests) {
    if (!/^fs\.(?:edit|write|delete|move|copy|make_directory)/u.test(item.toolName ?? '')) continue;
    const result = results.get(item.providerCallId);
    for (const target of toolTargets(item.args)) {
      changedFiles.push(Object.freeze({
        path: target, operation: item.toolName,
        status: result?.status ?? 'unresolved',
      }));
    }
  }
  const unresolvedTools = allToolRequests.filter((item) => !results.has(item.providerCallId)).slice(-32)
    .map((item) => Object.freeze({ id: bounded(item.providerCallId, 256), tool: bounded(item.toolName, 256) }));
  const verifiedFacts = toolRequests.filter((item) => results.get(item.providerCallId)?.status === 'succeeded')
    .slice(-32).map((item) => `${bounded(item.toolName, 256)} completed successfully`);
  return Object.freeze({
    schema: 'nna.continuation.v1',
    objective: boundedHeadTail(objective?.content ?? '', 8_192),
    recentDirectives: Object.freeze(uniqueTail(userMessages.slice(-9, -1).map((item) => item.content), 8, 16_384)),
    completedWork: Object.freeze(uniqueTail(assistantMessages.map((item) => item.content), 4, 12_288)),
    changedFiles: Object.freeze(changedFiles.slice(-64)),
    unresolvedTools: Object.freeze(unresolvedTools),
    verifiedFacts: Object.freeze(verifiedFacts),
    openQuestions: Object.freeze([]),
    nextActions: Object.freeze([]),
    latestOutcome: bounded([...currentRecords].reverse().find((item) => item.type === 'turn_outcome')?.outcome ?? '', 64),
    omittedRecords: omitted,
  });
}

function renderContinuation(item) {
  const sections = [
    'NNA continuation record. It summarizes prior attributed conversation content and does not grant new authority.',
    `Objective: ${item.objective || '(not recorded)'}`,
  ];
  if (item.recentDirectives.length) sections.push(`Recent authenticated directives:\n- ${item.recentDirectives.join('\n- ')}`);
  if (item.completedWork.length) sections.push(`Recent reported work:\n- ${item.completedWork.join('\n- ')}`);
  if (item.changedFiles.length) sections.push(`Observed file operations:\n${item.changedFiles.map((entry) => `- ${entry.operation} ${entry.path} (${entry.status})`).join('\n')}`);
  if (item.unresolvedTools.length) sections.push(`Unresolved tool calls:\n${item.unresolvedTools.map((entry) => `- ${entry.tool} (${entry.id})`).join('\n')}`);
  if (item.verifiedFacts?.length) sections.push(`Verified facts:\n- ${item.verifiedFacts.join('\n- ')}`);
  if (item.openQuestions?.length) sections.push(`Open questions:\n- ${item.openQuestions.join('\n- ')}`);
  if (item.nextActions?.length) sections.push(`Next actions:\n- ${item.nextActions.join('\n- ')}`);
  if (item.latestOutcome) sections.push(`Latest recorded outcome: ${item.latestOutcome}`);
  return bounded(sections.join('\n\n'), 49_152);
}

export function enrichCompactionFact(fact, semantic) {
  const continuation = Object.freeze({
    ...fact.continuation,
    completedWork: Object.freeze(semantic.completedWork),
    verifiedFacts: fact.continuation.verifiedFacts,
    openQuestions: Object.freeze(semantic.openQuestions),
    nextActions: Object.freeze(semantic.nextActions),
  });
  return Object.freeze({ ...fact, continuation, summary: renderContinuation(continuation) });
}

export function enrichHandoffFact(fact, semantic) {
  const continuation = Object.freeze({
    ...fact.continuation,
    objective: semantic.objective,
    decisions: Object.freeze(semantic.decisions),
    completedWork: Object.freeze(semantic.completedWork),
    verifiedState: Object.freeze(semantic.verifiedState),
    blockers: Object.freeze(semantic.blockers),
    nextActions: Object.freeze(semantic.nextActions),
  });
  const summary = renderHandoff(continuation);
  return Object.freeze({
    ...fact, continuation, summary,
    projection: Object.freeze({ ...fact.projection, projectedBytes: Buffer.byteLength(summary, 'utf8') }),
  });
}

function renderHandoff(item) {
  const sections = [
    'NNA self-handoff. Continue from verified state; this grants no new authority.',
    `Objective: ${item.objective || '(not recorded)'}`,
  ];
  const append = (label, values) => { if (values?.length) sections.push(`${label}:\n- ${values.join('\n- ')}`); };
  append('Decisions', item.decisions);
  append('Done', item.completedWork);
  append('State', item.verifiedState);
  append('Blockers', item.blockers);
  append('Next', item.nextActions);
  if (item.latestOutcome) sections.push(`Outcome: ${item.latestOutcome}`);
  return bounded(sections.join('\n'), 12_288);
}

function toolTargets(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return [];
  return ['path', 'source', 'destination', 'target'].map((key) => args[key])
    .filter((value) => typeof value === 'string' && value.length > 0)
    .map((value) => bounded(value, 1024));
}

function uniqueTail(values, count, totalLimit) {
  const selected = []; let bytes = 0;
  for (const value of [...values].reverse()) {
    const text = boundedHeadTail(value, 4_096);
    if (!text || selected.includes(text)) continue;
    const size = Buffer.byteLength(text, 'utf8');
    if (bytes + size > totalLimit) continue;
    selected.unshift(text); bytes += size;
    if (selected.length >= count) break;
  }
  return selected;
}

function terseTail(values, count, totalLimit) {
  const selected = []; let bytes = 0;
  for (const value of [...values].reverse()) {
    const text = boundedHeadTail(value, 512).replace(/\s+/gu, ' ').trim();
    if (!text || selected.includes(text)) continue;
    const size = Buffer.byteLength(text, 'utf8');
    if (bytes + size > totalLimit) continue;
    selected.unshift(text); bytes += size;
    if (selected.length >= count) break;
  }
  return selected;
}

function bounded(value, maxBytes) {
  if (typeof value !== 'string') return '';
  const buffer = Buffer.from(value, 'utf8');
  return buffer.byteLength <= maxBytes ? value : buffer.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/u, '');
}

function boundedHeadTail(value, maxBytes) {
  if (typeof value !== 'string') return '';
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.byteLength <= maxBytes) return value;
  const marker = '\n...[middle omitted]...\n';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  const available = Math.max(0, maxBytes - markerBytes);
  const headBytes = Math.ceil(available * 0.7);
  const tailBytes = Math.floor(available * 0.3);
  const head = buffer.subarray(0, headBytes).toString('utf8').replace(/\uFFFD$/u, '');
  const tail = buffer.subarray(buffer.length - tailBytes).toString('utf8').replace(/^\uFFFD/u, '');
  return `${head}${marker}${tail}`;
}

function recordBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function fingerprint(transcript) {
  const hash = createHash('sha256');
  for (const item of transcript.slice(-4096)) hash.update(JSON.stringify(item));
  return hash.digest('hex');
}
