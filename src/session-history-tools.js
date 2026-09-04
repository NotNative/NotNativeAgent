// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { redactExtensionData, redactText } from './redaction.js';

const MAX_QUERY = 512;
const MAX_SCAN_RECORDS = 50_000;
const MAX_SNIPPET = 720;
const DEFAULT_RESULTS = 8;
const MAX_RESULTS = 20;
const MAX_TYPES = 8;
const MAX_TYPE_LENGTH = 64;
const MAX_QUERY_TERMS = 24;
const MAX_SEARCHABLE_CHARACTERS = 32_768;
const MAX_TERM_OCCURRENCES = 8;
const LONG_TERM_CHARACTERS = 8;
const MEDIUM_TERM_CHARACTERS = 4;
const RECORD_BYTE_BUDGET = 524_288;
const MAX_RECORD_DEPTH = 12;
const MAX_COLLECTION_ITEMS = 128;

export function sessionHistoryDefinitions(control) {
  if (!control || typeof control.transcript !== 'function') return [];
  return [searchDefinition(control), readDefinition(control)];
}

function searchDefinition(control) {
  return definition('session.search_history',
    'Search older records in this conversation, including history omitted from the active model context. Returns stable record indexes for session.read_history.', {
      query: { type: 'string', minLength: 1, maxLength: MAX_QUERY, description: 'Required words or phrase to find in older conversation records.' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_RESULTS, description: `Maximum matching records to return. Defaults to ${DEFAULT_RESULTS}.` },
      types: { type: 'array', items: { type: 'string' }, maxItems: MAX_TYPES, description: 'Optional exact record-type filters, such as message or tool_result.' },
    }, ['query'], async (args, signal) => {
      const records = transcript(control);
      const result = await cooperativeSearchHistory(records, args, signal);
      const projected = output(result, { matches: result.matches.length, records_scanned: result.scanned });
      const rediscovery = rediscoveryDetail(control, projected.content);
      control.telemetry?.record('session.history_search', 'succeeded', {
        query_bytes: Buffer.byteLength(args.query, 'utf8'), records_scanned: result.scanned,
        matches: result.matches.length, truncated_scan: result.truncated, ...rediscovery,
      });
      return projected;
    });
}

function readDefinition(control) {
  return definition('session.read_history',
    'Read one record by record_index or a receipt ledger_ref. Ledger lookup selects the exact tool result. Optionally include neighboring records.', {
      record_index: { type: 'integer', minimum: 0, description: 'Exact index from session.search_history. Supply either record_index or ledger_ref, not both.' },
      ledger_ref: { type: 'string', minLength: 1, maxLength: 256, description: 'Exact receipt ledger_ref (request or provider-call ID). Searches the newest 50000 retained records.' },
      surrounding: { type: 'integer', minimum: 0, maximum: 3, description: 'Neighboring records to include on each side. Defaults to 0.' },
    }, [], async (args, signal) => {
      const records = transcript(control);
      const recordIndex = args.ledger_ref === undefined ? args.record_index : await ledgerRecordIndex(records, args.ledger_ref, signal);
      if (recordIndex < 0 || recordIndex >= records.length) {
        throw new ContractError('session_history_record_missing', 'record is unavailable in retained history; ledger_ref lookup searches the newest 50000 records');
      }
      const surrounding = args.surrounding ?? 0;
      const start = Math.max(0, recordIndex - surrounding);
      const end = Math.min(records.length, recordIndex + surrounding + 1);
      const budget = { remaining: RECORD_BYTE_BUDGET - 4096 };
      const selected = records.slice(start, end).map((record, offset) => projectRecord(record, start + offset, false, budget));
      const projected = output({ records: selected, total_records: records.length }, { records: selected.length });
      control.telemetry?.record('session.history_read', 'succeeded', {
        record_index: recordIndex, records_returned: selected.length,
        ...rediscoveryDetail(control, projected.content),
      });
      return projected;
    });
}

export function searchHistory(records, input) {
  const scan = historyScan(records, input);
  let step = scan.next();
  while (!step.done) step = scan.next();
  return step.value;
}

async function cooperativeSearchHistory(records, input, signal) {
  const scan = historyScan(records, input, signal);
  let step = scan.next();
  while (!step.done) { await yieldToEventLoop(); step = scan.next(); }
  return step.value;
}

function* historyScan(records, input, signal) {
  const query = String(input.query ?? '').trim();
  if (!query || query.length > MAX_QUERY) throw new ContractError('session_history_query_invalid', 'history query must contain 1 to 512 characters');
  const limit = Number.isSafeInteger(input.limit) ? input.limit : DEFAULT_RESULTS;
  if (limit < 1 || limit > MAX_RESULTS) {
    throw new ContractError('session_history_limit_invalid', `history search limit must be between 1 and ${MAX_RESULTS}`);
  }
  const types = normalizeTypes(input.types);
  const start = Math.max(0, records.length - MAX_SCAN_RECORDS);
  const terms = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}_.:/-]+/u)
    .filter((term) => term.length > 1))].slice(0, MAX_QUERY_TERMS);
  const phrase = query.toLowerCase();
  const matches = [];
  let searchTextTruncatedRecords = 0;
  for (let index = start; index < records.length; index += 1) {
    if ((index - start) % 32 === 0) yield;
    assertNotCancelled(signal);
    const record = records[index];
    const type = String(record?.type ?? 'unknown');
    if (types && !types.has(type)) continue;
    const projection = searchableText(record);
    if (projection.truncated) searchTextTruncatedRecords += 1;
    const searchable = projection.text.toLowerCase();
    const score = relevance(searchable, phrase, terms);
    if (score <= 0) continue;
    matches.push({ score, index, record });
  }
  matches.sort((left, right) => right.score - left.score || right.index - left.index);
  const budget = { remaining: RECORD_BYTE_BUDGET - 4096 };
  return Object.freeze({
    query, scanned: records.length - start, truncated: start > 0,
    search_text_truncated_records: searchTextTruncatedRecords,
    matches: matches.slice(0, limit).map((item) => ({
      ...projectRecord(item.record, item.index, true, budget), relevance: item.score,
    })),
  });
}

function definition(name, purpose, properties, required, execute) {
  return {
    name, version: 1, purpose, sideEffect: 'read_only', scope: 'session', cancellation: true, timeoutMs: 2_000,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    validate: async (args) => {
      if (!args || typeof args !== 'object' || Array.isArray(args)
        || required.some((key) => !Object.hasOwn(args, key))
        || Object.keys(args).some((key) => !Object.hasOwn(properties, key))) {
        throw new ContractError('tool_schema_invalid', `${name} received invalid arguments`);
      }
      validateArguments(name, args);
      return { args: structuredClone(args), resolved: { scope: 'active_session' } };
    },
    executor: async (request, signal) => {
      if (signal.aborted) throw new ContractError('tool_cancelled', 'session history lookup was cancelled');
      return execute(request.args, signal);
    },
  };
}

function validateArguments(name, args) {
  if (name === 'session.read_history') {
    if (Object.hasOwn(args, 'record_index') === Object.hasOwn(args, 'ledger_ref')) invalid(name);
    if (args.ledger_ref !== undefined && (typeof args.ledger_ref !== 'string'
      || args.ledger_ref.length < 1 || args.ledger_ref.length > 256)) invalid(name);
    if (args.record_index < 0 || args.surrounding < 0 || args.surrounding > 3) invalid(name);
  }
  if (Object.hasOwn(args, 'query') && (typeof args.query !== 'string' || args.query.trim().length < 1 || args.query.length > MAX_QUERY)) invalid(name);
  for (const key of ['limit', 'record_index', 'surrounding']) {
    if (Object.hasOwn(args, key) && !Number.isSafeInteger(args[key])) invalid(name);
  }
  if (Object.hasOwn(args, 'types') && (!Array.isArray(args.types) || args.types.length > MAX_TYPES
    || args.types.some((type) => typeof type !== 'string'
      || type.length < 1 || type.length > MAX_TYPE_LENGTH))) invalid(name);
}

async function ledgerRecordIndex(records, reference, signal) {
  const start = Math.max(0, records.length - MAX_SCAN_RECORDS);
  for (let index = records.length - 1; index >= start; index -= 1) {
    if ((records.length - 1 - index) % 32 === 0) await yieldToEventLoop();
    assertNotCancelled(signal);
    const record = records[index];
    if (record?.type === 'tool_result'
      && [record.requestId, record.providerCallId, record.request_id, record.provider_call_id].includes(reference)) return index;
  }
  return -1;
}

function transcript(control) {
  const records = control.transcript();
  if (!Array.isArray(records)) throw new ContractError('session_history_unavailable', 'active session history is unavailable');
  return records;
}

function normalizeTypes(value) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > MAX_TYPES) {
    throw new ContractError('session_history_types_invalid', `history types must contain at most ${MAX_TYPES} record types`);
  }
  return new Set(value.map((item) => String(item)));
}

function searchableText(record) {
  if (!record || typeof record !== 'object') return { text: String(record ?? ''), truncated: false };
  const values = [record.type, record.role, record.requestId, record.providerCallId,
    record.request_id, record.provider_call_id, record.content, record.tool, record.toolName,
    record.target, record.status, record.outcome, record.reason, record.reason_code,
    record.turn_id, record.turnId, record.metadata, record.args, record.arguments];
  const combined = values.map((value) => typeof value === 'string' ? value : safeJson(value)).join('\n');
  return {
    text: combined.slice(0, MAX_SEARCHABLE_CHARACTERS),
    truncated: combined.length > MAX_SEARCHABLE_CHARACTERS,
  };
}

function relevance(text, phrase, terms) {
  let score = phrase.length > 1 && text.includes(phrase) ? 100 : 0;
  for (const term of terms) {
    let offset = 0; let count = 0;
    while (count < MAX_TERM_OCCURRENCES && (offset = text.indexOf(term, offset)) >= 0) {
      count += 1;
      offset += term.length;
    }
    score += count * (term.length >= LONG_TERM_CHARACTERS
      ? 8 : term.length >= MEDIUM_TERM_CHARACTERS ? 4 : 2);
  }
  return score;
}

function projectRecord(record, index, snippetOnly, budget) {
  const redacted = boundValue(redactExtensionData(record), budget, 0);
  const base = { record_index: index, type: String(record?.type ?? 'unknown').slice(0, MAX_TYPE_LENGTH) };
  if (!snippetOnly) return { ...base, record: redacted };
  const text = redactText(searchableText(redacted).text).replace(/\s+/gu, ' ').trim();
  const turnId = record?.turn_id ?? record?.turnId;
  return { ...base, turn_id: typeof turnId === 'string' ? turnId.slice(0, 256) : null, snippet: text.slice(0, MAX_SNIPPET) };
}

function boundValue(value, budget, depth) {
  if (budget.remaining <= 0) return '[truncated:record-budget]';
  if (depth > MAX_RECORD_DEPTH) return '[truncated:depth-limit]';
  if (typeof value === 'string') {
    let low = 0, high = Math.min(value.length, Math.max(0, budget.remaining - 32));
    const maximum = Math.max(0, budget.remaining - 32);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (Buffer.byteLength(JSON.stringify(value.slice(0, middle))) <= maximum) low = middle;
      else high = middle - 1;
    }
    if (low < value.length && low > 0 && /[\uD800-\uDBFF]/u.test(value[low - 1])) low -= 1;
    const text = value.slice(0, low) + (low < value.length ? '[truncated]' : '');
    budget.remaining -= Buffer.byteLength(JSON.stringify(text));
    return text;
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_COLLECTION_ITEMS).map((item) => boundValue(item, budget, depth + 1));
  }
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value).slice(0, MAX_COLLECTION_ITEMS)) {
    result[key] = boundValue(child, budget, depth + 1);
    if (budget.remaining <= 0) break;
  }
  return result;
}

function output(value, metadata) {
  let content = JSON.stringify(value, null, 2);
  // Invariant: JSON escaping and indentation count toward the aggregate tool bound.
  for (let index = (value.records?.length ?? 0) - 1; Buffer.byteLength(content) > RECORD_BYTE_BUDGET && index >= 0; index -= 1) {
    const record = value.records[index];
    value.records[index] = { record_index: record.record_index, type: record.type, record: '[truncated:output-budget]' };
    value.truncated = true;
    content = JSON.stringify(value, null, 2);
  }
  return { content, metadata: { ...metadata, truncated: value.truncated === true } };
}

function assertNotCancelled(signal) {
  if (signal?.aborted) throw new ContractError('tool_cancelled', 'session history lookup was cancelled');
}
function rediscoveryDetail(control, content) {
  const state = typeof control.compressionState === 'function' ? control.compressionState() : null;
  const bytes = Buffer.byteLength(content, 'utf8');
  const tier = typeof state?.tier === 'string' ? state.tier : 'none';
  const compactionAttempts = Number.isSafeInteger(state?.compactionAttempts) ? state.compactionAttempts : 0;
  return {
    compression_induced: tier !== 'none' || compactionAttempts > 0,
    compression_tier: tier,
    compaction_attempts: compactionAttempts,
    rediscovery_bytes: bytes,
    rediscovery_estimated_tokens: Math.ceil(bytes / 4),
  };
}
function safeJson(value) { try { return JSON.stringify(value) ?? ''; } catch { return ''; } }
function invalid(name) { throw new ContractError('tool_schema_invalid', `${name} received invalid arguments`); }
