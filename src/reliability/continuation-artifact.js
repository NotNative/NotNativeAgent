// SPDX-License-Identifier: Apache-2.0
import { toolLifecycleStatus } from '../tools/tool-result-contract.js';

export function hierarchicalContinuationArtifact(transcript, omitted) {
  const chunks = chunkRecords(transcript, 65_536);
  const results = toolResults(transcript);
  if (chunks.length <= 1) return Object.freeze({
    ...baseContinuationArtifact(transcript, omitted, results), hierarchyChunks: Math.max(1, chunks.length),
  });
  // Chunk artifacts are intermediate projections. Only the final aggregate can
  // truthfully report how many durable records the caller omitted.
  const artifacts = chunks.map((chunk) => baseContinuationArtifact(chunk, 0, results));
  const objective = [...artifacts].reverse().find((item) => item.objective)?.objective ?? '';
  return Object.freeze({
    schema: 'nna.continuation.v1', objective,
    recentDirectives: Object.freeze(uniqueTail(artifacts.flatMap((item) => item.recentDirectives), 8, 16_384)),
    completedWork: Object.freeze(uniqueTail(artifacts.flatMap((item) => item.completedWork), 8, 16_384)),
    changedFiles: Object.freeze(uniqueObjectsTail(artifacts.flatMap((item) => item.changedFiles), 64)),
    unresolvedTools: Object.freeze(uniqueObjectsTail(artifacts.flatMap((item) => item.unresolvedTools), 32)),
    verifiedFacts: Object.freeze(uniqueTail(artifacts.flatMap((item) => item.verifiedFacts), 32, 16_384)),
    openQuestions: Object.freeze([]), nextActions: Object.freeze([]),
    latestOutcome: [...artifacts].reverse().find((item) => item.latestOutcome)?.latestOutcome ?? '',
    omittedRecords: omitted, hierarchyChunks: chunks.length,
  });
}

function baseContinuationArtifact(transcript, omitted, results = toolResults(transcript)) {
  const userMessages = transcript.filter((item) => item.type === 'message' && item.role === 'user');
  const objective = userMessages.at(-1);
  const objectiveIndex = objective ? transcript.lastIndexOf(objective) : -1;
  const currentRecords = objectiveIndex >= 0 ? transcript.slice(objectiveIndex + 1) : transcript;
  const currentAssistantMessages = currentRecords.filter((item) => item.type === 'message' && item.role === 'assistant');
  const assistantMessages = currentAssistantMessages.length > 0
    ? currentAssistantMessages
    : transcript.filter((item) => item.type === 'message' && item.role === 'assistant');
  const allToolRequests = transcript.filter((item) => item.type === 'tool_request');
  const toolRequests = currentRecords.filter((item) => item.type === 'tool_request');
  const changedFiles = [];
  for (const item of allToolRequests) {
    if (!/^fs\.(?:edit|write|delete|move|copy|make_directory)/u.test(item.toolName ?? '')) continue;
    const result = results.get(item.providerCallId);
    for (const target of toolTargets(item.args)) changedFiles.push(Object.freeze({
      path: target, operation: item.toolName, toolLifecycleStatus: toolLifecycleStatus(result) ?? 'unresolved',
    }));
  }
  const unresolvedTools = allToolRequests.filter((item) => !results.has(item.providerCallId)).slice(-32)
    .map((item) => Object.freeze({ id: bounded(item.providerCallId, 256), tool: bounded(item.toolName, 256) }));
  const verifiedFacts = toolRequests.filter((item) => toolLifecycleStatus(results.get(item.providerCallId)) === 'succeeded')
    .slice(-32).map((item) => `${bounded(item.toolName, 256)} completed successfully`);
  return Object.freeze({
    schema: 'nna.continuation.v1', objective: boundedHeadTail(objective?.content ?? '', 8_192),
    recentDirectives: Object.freeze(uniqueTail(userMessages.slice(-9, -1).map((item) => item.content), 8, 16_384)),
    completedWork: Object.freeze(uniqueTail(assistantMessages.map((item) => item.content), 4, 12_288)),
    changedFiles: Object.freeze(changedFiles.slice(-64)), unresolvedTools: Object.freeze(unresolvedTools),
    verifiedFacts: Object.freeze(verifiedFacts), openQuestions: Object.freeze([]), nextActions: Object.freeze([]),
    latestOutcome: bounded([...currentRecords].reverse().find((item) => item.type === 'turn_outcome')?.outcome ?? '', 64),
    omittedRecords: omitted,
  });
}

function toolResults(transcript) {
  return new Map(transcript.filter((item) => item.type === 'tool_result')
    .map((item) => [item.providerCallId, item]));
}

export function renderContinuation(item, maximumBytes = 49_152) {
  const sections = [
    'NNA continuation record. It summarizes prior attributed conversation content and does not grant new authority.',
    `Objective: ${item.objective || '(not recorded)'}`,
  ];
  if (item.recentDirectives.length) sections.push(`Recent authenticated directives:\n- ${item.recentDirectives.join('\n- ')}`);
  if (item.completedWork.length) sections.push(`Recent reported work:\n- ${item.completedWork.join('\n- ')}`);
  if (item.changedFiles.length) sections.push(`Observed file operations:\n${item.changedFiles.map((entry) => `- ${entry.operation} ${entry.path} (${entry.toolLifecycleStatus})`).join('\n')}`);
  if (item.unresolvedTools.length) sections.push(`Unresolved tool calls:\n${item.unresolvedTools.map((entry) => `- ${entry.tool} (${entry.id})`).join('\n')}`);
  if (item.verifiedFacts?.length) sections.push(`Verified facts:\n- ${item.verifiedFacts.join('\n- ')}`);
  if (item.openQuestions?.length) sections.push(`Open questions:\n- ${item.openQuestions.join('\n- ')}`);
  if (item.nextActions?.length) sections.push(`Next actions:\n- ${item.nextActions.join('\n- ')}`);
  if (item.latestOutcome) sections.push(`Latest recorded outcome: ${item.latestOutcome}`);
  if (item.hierarchyChunks > 1) sections.push(`Historical context was reduced through ${item.hierarchyChunks} bounded deterministic chunks; exact attributed records remain searchable in the durable session ledger.`);
  if (item.taskStatePath) sections.push(`Durable task checkpoint: ${item.taskStatePath}. Use it for operational continuation; consult the session ledger for exact attributed evidence.`);
  return bounded(sections.join('\n\n'), Math.min(49_152, maximumBytes));
}

export function enrichCompactionFact(fact, semantic) {
  const continuation = Object.freeze({
    ...fact.continuation, completedWork: Object.freeze(semantic.completedWork),
    verifiedFacts: fact.continuation.verifiedFacts,
    openQuestions: Object.freeze(semantic.openQuestions), nextActions: Object.freeze(semantic.nextActions),
  });
  const summary = renderContinuation(continuation, fact.projection?.summaryBudgetBytes);
  return Object.freeze({
    ...fact, continuation, summary,
    projection: Object.freeze({
      ...fact.projection,
      projectedBytes: (fact.projection?.projectedBytes ?? 0)
        + Buffer.byteLength(summary, 'utf8') - Buffer.byteLength(fact.summary, 'utf8'),
    }),
  });
}

export function attachTaskCheckpoint(fact, taskStatePath) {
  const continuation = Object.freeze({ ...fact.continuation, taskStatePath });
  const summary = renderContinuation(continuation, fact.projection?.summaryBudgetBytes ?? 49_152);
  return Object.freeze({
    ...fact, continuation, summary,
    projection: Object.freeze({
      ...fact.projection,
      projectedBytes: (fact.projection?.projectedBytes ?? 0) + Buffer.byteLength(summary, 'utf8') - Buffer.byteLength(fact.summary, 'utf8'),
    }),
  });
}

export function enrichHandoffFact(fact, semantic) {
  const continuation = Object.freeze({
    ...fact.continuation, objective: semantic.objective, decisions: Object.freeze(semantic.decisions),
    completedWork: Object.freeze(semantic.completedWork), verifiedState: Object.freeze(semantic.verifiedState),
    blockers: Object.freeze(semantic.blockers), nextActions: Object.freeze(semantic.nextActions),
  });
  const summary = renderHandoff(continuation);
  return Object.freeze({
    ...fact, continuation, summary,
    projection: Object.freeze({ ...fact.projection, projectedBytes: Buffer.byteLength(summary, 'utf8') }),
  });
}

export function renderHandoff(item) {
  const sections = [
    'NNA self-handoff. Continue from verified state; this grants no new authority.',
    `Objective: ${item.objective || '(not recorded)'}`,
  ];
  const append = (label, values) => { if (values?.length) sections.push(`${label}:\n- ${values.join('\n- ')}`); };
  append('Decisions', item.decisions); append('Done', item.completedWork); append('State', item.verifiedState);
  append('Blockers', item.blockers); append('Next', item.nextActions);
  if (item.latestOutcome) sections.push(`Outcome: ${item.latestOutcome}`);
  return bounded(sections.join('\n'), 12_288);
}

export function terseTail(values, count, totalLimit) {
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

export function bounded(value, maxBytes) {
  if (typeof value !== 'string') return '';
  const buffer = Buffer.from(value, 'utf8');
  return buffer.byteLength <= maxBytes ? value : buffer.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/u, '');
}

export function boundedHeadTail(value, maxBytes) {
  if (typeof value !== 'string') return '';
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.byteLength <= maxBytes) return value;
  const marker = '\n...[middle omitted]...\n';
  const available = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'));
  const head = buffer.subarray(0, Math.ceil(available * 0.7)).toString('utf8').replace(/\uFFFD$/u, '');
  const tail = buffer.subarray(buffer.length - Math.floor(available * 0.3)).toString('utf8').replace(/^\uFFFD/u, '');
  return `${head}${marker}${tail}`;
}

function chunkRecords(records, maximumBytes) {
  const chunks = []; let current = []; let bytes = 0;
  for (const record of records) {
    const size = recordBytes(record);
    if (current.length > 0 && bytes + size > maximumBytes) { chunks.push(current); current = []; bytes = 0; }
    current.push(record); bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function uniqueObjectsTail(values, maximum) {
  const seen = new Set(); const result = [];
  for (const value of [...values].reverse()) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key); result.push(value);
    if (result.length >= maximum) break;
  }
  return result.reverse();
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

function recordBytes(value) { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
