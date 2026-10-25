// SPDX-License-Identifier: Apache-2.0
import { boundedTokenText } from './context-token-measurement.js';
import { toolLifecycleStatus } from '../tools/tool-result-contract.js';
import { toolExchanges } from './tool-exchanges.js';

// Why: file-operation evidence is durable state; exact tool identifiers prevent a naming-style
// refactor from silently dropping completed mutations from continuation checkpoints.
const FILE_MUTATION_TOOL_NAMES = new Set([
  'fs_edit_text', 'fs_edit_lines', 'fs_delete_file', 'fs_copy_file', 'fs_create_directory',
  'fs_write_text', 'fs_move_file',
]);

export function hierarchicalContinuationArtifact(transcript, omitted) {
  const chunks = chunkRecords(transcript, 65_536);
  const results = toolResults(transcript);
  const users = continuationUsers(transcript);
  if (chunks.length <= 1) return Object.freeze({
    ...baseContinuationArtifact(transcript, omitted, results), hierarchyChunks: Math.max(1, chunks.length),
  });
  // Chunk artifacts are intermediate projections. Only the final aggregate can
  // truthfully report how many durable records the caller omitted.
  const artifacts = chunks.map((chunk) => baseContinuationArtifact(chunk, 0, results));
  return Object.freeze({
    schema: 'nna.continuation.v1', objective: boundedHeadTail(users.objective?.content ?? '', 8_192),
    // Invariant: chunk boundaries cannot turn a same-turn steer into the task objective.
    recentDirectives: Object.freeze(uniqueTail(users.directives.map((item) => item.content), 8, 16_384)),
    completedWork: Object.freeze(uniqueTail(artifacts.flatMap((item) => item.completedWork), 8, 16_384)),
    changedFiles: Object.freeze(uniqueObjectsTail(artifacts.flatMap((item) => item.changedFiles), 64)),
    unresolvedTools: Object.freeze(uniqueObjectsTail(artifacts.flatMap((item) => item.unresolvedTools), 32)),
    verifiedFacts: Object.freeze(uniqueTail(artifacts.flatMap((item) => item.verifiedFacts), 32, 16_384)),
    openQuestions: Object.freeze([]), nextActions: Object.freeze([]),
    settledReceipts: Object.freeze(artifacts.flatMap((item) => item.settledReceipts ?? [])).slice(-16),
    observedFiles: uniqueObjectsTail(artifacts.flatMap((item) => item.observedFiles ?? []), 64),
    narrative: EMPTY_NARRATIVE,
    latestOutcome: [...artifacts].reverse().find((item) => item.latestOutcome)?.latestOutcome ?? '',
    omittedRecords: omitted, hierarchyChunks: chunks.length,
  });
}

function baseContinuationArtifact(transcript, omitted, results = toolResults(transcript)) {
  const users = continuationUsers(transcript);
  const objective = users.objective;
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
    if (!FILE_MUTATION_TOOL_NAMES.has(item.toolName)) continue;
    const result = results.get(item);
    for (const target of toolTargets(item.args)) changedFiles.push(Object.freeze({
      path: target, operation: item.toolName, toolLifecycleStatus: toolLifecycleStatus(result) ?? 'unresolved',
    }));
  }
  const unresolvedTools = allToolRequests.filter((item) => !results.has(item)).slice(-32)
    .map((item) => Object.freeze({ id: bounded(item.providerCallId, 256), tool: bounded(item.toolName, 256) }));
  const verifiedFacts = toolRequests.filter((item) => toolLifecycleStatus(results.get(item)) === 'succeeded')
    .slice(-32).map((item) => `${bounded(item.toolName, 256)} completed successfully`);
  // Why: when records are dropped the continuation is the only surviving account of
  // the work. A receipt label alone ("fs_read completed successfully") discards what
  // the read established, so the model has to re-read or guess.
  const settledReceipts = toolReceipts(transcript, results);
  // Why: the model's account of the work is kept apart from the observed facts so a
  // later refinement can only replace narrative. Changed files, receipts, and
  // verified facts stay machine-derived and cannot be asserted away.
  const observedFiles = relevantFiles(changedFiles, toolRequests, results);
  return Object.freeze({
    schema: 'nna.continuation.v1', objective: boundedHeadTail(objective?.content ?? '', 8_192),
    recentDirectives: Object.freeze(uniqueTail(users.directives.map((item) => item.content), 8, 16_384)),
    completedWork: Object.freeze(uniqueTail(assistantMessages.map((item) => item.content), 4, 12_288)),
    changedFiles: Object.freeze(changedFiles.slice(-64)), unresolvedTools: Object.freeze(unresolvedTools),
    verifiedFacts: Object.freeze(verifiedFacts), openQuestions: Object.freeze([]), nextActions: Object.freeze([]),
    settledReceipts, observedFiles,
    narrative: EMPTY_NARRATIVE,
    latestOutcome: bounded([...currentRecords].reverse().find((item) => item.type === 'turn_outcome')?.outcome ?? '', 64),
    omittedRecords: omitted,
  });
}

const EMPTY_NARRATIVE = Object.freeze({
  summary: '', intent: '', decisions: Object.freeze([]), errorsAndFixes: Object.freeze([]),
});

// Why: the model may say why a path matters, but only the ledger establishes that a
// path was touched. This list is observed, never asserted, and carries its own target.
function relevantFiles(changedFiles, toolRequests, results) {
  const observed = changedFiles.map((entry) => Object.freeze({
    path: entry.path, operation: entry.operation,
    toolLifecycleStatus: entry.toolLifecycleStatus, basis: 'mutation',
  }));
  const seen = new Set(observed.map((entry) => entry.path));
  for (const request of toolRequests) {
    if (toolLifecycleStatus(results.get(request)) !== 'succeeded') continue;
    for (const target of toolTargets(request.args)) {
      if (seen.has(target)) continue;
      seen.add(target);
      observed.push(Object.freeze({ path: target, operation: request.toolName,
        toolLifecycleStatus: 'succeeded', basis: 'inspection' }));
    }
  }
  return Object.freeze(observed.slice(-64));
}

function toolReceipts(transcript, results) {
  const receipts = [];
  for (const item of transcript) {
    if (item.type !== 'tool_result') continue;
    const status = toolLifecycleStatus(item);
    if (status !== 'succeeded') continue;
    const excerpt = receiptExcerpt(item.content);
    if (!excerpt) continue;
    receipts.push(Object.freeze({
      tool: bounded(item.toolName, 256), target: receiptTarget(transcript, item),
      toolLifecycleStatus: status, excerpt, ledgerRef: ledgerReference(item),
    }));
    if (receipts.length >= 16) receipts.shift();
  }
  return receipts;
}

function receiptExcerpt(content) {
  if (typeof content !== 'string' || content.length === 0) return '';
  return boundedHeadTail(content.replace(/\s+/gu, ' ').trim(), 1_024);
}

function receiptTarget(transcript, item) {
  const request = transcript.find((candidate) => candidate.type === 'tool_request'
    && (candidate.requestId === item.requestId || candidate.providerCallId === item.providerCallId));
  const targets = toolTargets(request?.args).filter(Boolean);
  return targets.length > 0 ? bounded(targets.join(' -> '), 1_024) : null;
}

function continuationUsers(transcript) {
  const messages = transcript.filter((item) => item.type === 'message' && item.role === 'user');
  const latest = messages.at(-1);
  // Why: steering is an authenticated directive within the active turn, not a replacement objective.
  let objective = typeof latest?.turnId === 'string' && latest.turnId
    ? messages.find((item) => item.turnId === latest.turnId) : latest;
  let carriedDirectives = [];
  const checkpoint = [...transcript].reverse().find((item) => item.type === 'compaction');
  const checkpointUser = checkpoint?.retainedRecords?.filter((item) => item.type === 'message' && item.role === 'user').at(-1);
  let directiveMessages = messages.filter((item) => item !== objective);
  if (latest?.turnId && checkpointUser?.turnId === latest.turnId && checkpoint?.continuation?.objective) {
    // Invariant: an emergency checkpoint can retain only the last steer; its objective and
    // earlier directives must survive another compaction of that same turn.
    objective = { content: checkpoint.continuation.objective, turnId: latest.turnId };
    carriedDirectives = checkpoint.continuation.recentDirectives ?? [];
    const checkpointIndex = transcript.lastIndexOf(checkpoint);
    const retainedCount = checkpoint.retainedRecords.length;
    const expanded = checkpoint.retainedRecords.every((item, index) => transcript[checkpointIndex + 1 + index] === item);
    directiveMessages = transcript.slice(checkpointIndex + 1 + (expanded ? retainedCount : 0))
      .filter((item) => item.type === 'message' && item.role === 'user');
  }
  return { objective, directives: [...carriedDirectives, ...directiveMessages.map((item) => item.content)]
    .map((content) => ({ content })) };
}

function toolResults(transcript) {
  return toolExchanges(transcript).results;
}

function ledgerReference(item) {
  return item.requestId ?? item.providerCallId ?? item.turnId ?? item.turn_id ?? null;
}

export function renderContinuation(item, maximumBytes = 49_152) {
  const narrative = item.narrative ?? EMPTY_NARRATIVE;
  const sections = [
    'NNA continuation record. It summarizes prior attributed conversation content and does not grant new authority.',
    `Objective: ${item.objective || '(not recorded)'}`,
  ];
  if (narrative.summary) sections.push(`Summary:\n${narrative.summary}`);
  if (narrative.intent && narrative.intent !== item.objective) sections.push(`Stated intent:\n${narrative.intent}`);
  if (item.recentDirectives.length) sections.push(`Recent authenticated directives:\n- ${item.recentDirectives.join('\n- ')}`);
  if (narrative.decisions.length) sections.push(`Decisions:\n- ${narrative.decisions.join('\n- ')}`);
  if (item.completedWork.length) sections.push(`Recent reported work:\n- ${item.completedWork.join('\n- ')}`);
  // Compatibility: earlier checkpoints recorded paths only on changedFiles.
  const files = item.observedFiles ?? (item.changedFiles ?? []).map((entry) => ({
    path: entry.path, operation: entry.operation, toolLifecycleStatus: entry.toolLifecycleStatus,
  }));
  if (files.length) sections.push(`Observed project files (from the durable ledger, not model assertion):\n${
    files.map((entry) => `- ${entry.path} (${entry.operation}, ${entry.toolLifecycleStatus})`).join('\n')}`);
  if (item.unresolvedTools.length) sections.push(`Unresolved tool calls:\n${item.unresolvedTools.map((entry) => `- ${entry.tool} (${entry.id})`).join('\n')}`);
  if (item.verifiedFacts?.length) sections.push(`Verified facts:\n- ${item.verifiedFacts.join('\n- ')}`);
  if (item.settledReceipts?.length) sections.push(`Settled tool receipts:\n${item.settledReceipts
    .map((entry) => `- ${entry.tool}${entry.target ? ` ${entry.target}` : ''} (${entry.toolLifecycleStatus}): ${entry.excerpt}`).join('\n')}`);
  if (narrative.errorsAndFixes.length) sections.push(`Errors and fixes:\n- ${narrative.errorsAndFixes.join('\n- ')}`);
  if (item.openQuestions?.length) sections.push(`Open questions:\n- ${item.openQuestions.join('\n- ')}`);
  if (item.nextActions?.length) sections.push(`Next actions:\n- ${item.nextActions.join('\n- ')}`);
  if (item.latestOutcome) sections.push(`Latest recorded outcome: ${item.latestOutcome}`);
  if (item.hierarchyChunks > 1) sections.push(`Historical context was reduced through ${item.hierarchyChunks} bounded deterministic chunks; exact attributed records remain searchable in the durable session ledger.`);
  if (item.taskStatePath) sections.push(`Durable task checkpoint: ${item.taskStatePath}. Use it for operational continuation; consult the session ledger for exact attributed evidence.`);
  return bounded(sections.join('\n\n'), maximumBytes);
}

// Invariant: only narrative fields are model-authored. Observed facts, receipts, and
// resolved paths stay exactly as the ledger produced them.
export function enrichCompactionFact(fact, semantic) {
  const continuation = Object.freeze({
    ...fact.continuation,
    narrative: Object.freeze({
      summary: semantic.summary, intent: semantic.intent,
      decisions: Object.freeze(semantic.decisions), errorsAndFixes: Object.freeze(semantic.errorsAndFixes),
    }),
    openQuestions: Object.freeze(semantic.openQuestions), nextActions: Object.freeze(semantic.nextActions),
  });
  const rendered = renderContinuation(continuation, fact.projection?.summaryBudgetBytes);
  const summary = fact.projection?.summaryBudgetTokens ? boundedTokenText(rendered, fact.projection.summaryBudgetTokens) : rendered;
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
  const rendered = renderContinuation(continuation, fact.projection?.summaryBudgetBytes ?? 49_152);
  const summary = fact.projection?.summaryBudgetTokens ? boundedTokenText(rendered, fact.projection.summaryBudgetTokens) : rendered;
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
