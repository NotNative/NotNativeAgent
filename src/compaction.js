// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { ContractError } from './ids.js';

export function compactTranscript(transcript, maxBytes) {
  const budget = Math.floor(maxBytes * 0.55);
  const selected = selectRecentRecords(transcript, budget);
  const bytes = selected.reduce((sum, entry) => sum + recordBytes(entry.item), 0);
  if (bytes > maxBytes * 0.65) {
    throw new ContractError(
      'compaction_insufficient',
      'mandatory context still exceeds the provider budget; reduce the request or attachments, clear the conversation, or select a model with a larger context limit',
    );
  }
  const omitted = Math.max(0, transcript.length - selected.length);
  const continuation = continuationArtifact(transcript, omitted);
  const fact = Object.freeze({
    type: 'compaction', version: 2, omitted,
    sourceFingerprint: fingerprint(transcript),
    continuation,
    summary: renderContinuation(continuation),
    retainedRecords: Object.freeze(selected.map((entry) => Object.freeze(entry.item))),
  });
  return Object.freeze({ records: fact.retainedRecords, fact });
}

function selectRecentRecords(transcript, budget) {
  const projected = supersedeColdToolResults(transcript);
  const normalized = projected.map((item, index) => ({ index, item: compactRecord(item, budget) }));
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
  if (latestUser) add(units.find((unit) => unit.entries.some((entry) => entry.index === latestUser.index)), true);
  for (const unit of [...units].sort((a, b) => b.priority - a.priority)) {
    if (unit.entries.some((entry) => selected.has(entry.index))) continue;
    add(unit);
  }
  return [...selected.values()].sort((a, b) => a.index - b.index);
}

function supersedeColdToolResults(transcript) {
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
  return transcript.map((item, index) => {
    const key = keys.get(index);
    if (!key || latest.get(key) === index) return item;
    const notice = '[Older successful tool output superseded by a newer result for the same target; full output remains in the session journal.]';
    if (Buffer.byteLength(String(item.content ?? ''), 'utf8') - Buffer.byteLength(notice, 'utf8') < 512) return item;
    return { ...item, content: notice, metadata: { compacted: true, reason: 'superseded_result' } };
  });
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

function compactRecord(item, budget) {
  if (item.type === 'tool_result') {
    const cap = Math.max(2_048, Math.min(16_384, Math.floor(budget / 8)));
    const content = bounded(item.content ?? '', cap);
    const truncated = content !== (item.content ?? '');
    return {
      ...item, content: truncated ? `${content}\n[Tool output truncated by context compaction; the complete result remains in the session journal.]` : content,
      metadata: boundedMetadata(item.metadata),
    };
  }
  if (item.type === 'message') return { ...item, content: bounded(item.content ?? '', 32_768) };
  if (item.type === 'compaction') {
    const { retainedRecords: _retainedRecords, ...checkpoint } = item;
    return checkpoint;
  }
  return item;
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
  const assistantMessages = currentRecords.filter((item) => item.type === 'message' && item.role === 'assistant');
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
    objective: bounded(objective?.content ?? '', 8_192),
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

function toolTargets(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return [];
  return ['path', 'source', 'destination', 'target'].map((key) => args[key])
    .filter((value) => typeof value === 'string' && value.length > 0)
    .map((value) => bounded(value, 1024));
}

function uniqueTail(values, count, totalLimit) {
  const selected = []; let bytes = 0;
  for (const value of [...values].reverse()) {
    const text = bounded(value, 4_096);
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

function recordBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function fingerprint(transcript) {
  const hash = createHash('sha256');
  for (const item of transcript.slice(-4096)) hash.update(JSON.stringify(item));
  return hash.digest('hex');
}
