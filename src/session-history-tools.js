// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { redactExtensionData, redactText } from './redaction.js';

const MAX_QUERY = 512;
const MAX_SCAN_RECORDS = 50_000;
const MAX_SNIPPET = 720;

export function sessionHistoryDefinitions(control) {
  if (!control || typeof control.transcript !== 'function') return [];
  return [searchDefinition(control), readDefinition(control)];
}

function searchDefinition(control) {
  return definition('session.search_history',
    'Search older records in this conversation, including history omitted from the active model context. Returns stable record indexes for session.read_history.', {
      query: { type: 'string', minLength: 1, maxLength: MAX_QUERY, description: 'Required words or phrase to find in older conversation records.' },
      limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum matching records to return. Defaults to 8.' },
      types: { type: 'array', items: { type: 'string' }, maxItems: 8, description: 'Optional exact record-type filters, such as message or tool_result.' },
    }, ['query'], async (args) => {
      const records = transcript(control);
      const result = searchHistory(records, args);
      control.telemetry?.record('session.history_search', 'succeeded', {
        query_bytes: Buffer.byteLength(args.query, 'utf8'), records_scanned: result.scanned,
        matches: result.matches.length, truncated_scan: result.truncated,
      });
      return output(result, { matches: result.matches.length, records_scanned: result.scanned });
    });
}

function readDefinition(control) {
  return definition('session.read_history',
    'Read one exact record from this conversation by the record_index returned from session.search_history. Optionally include up to three neighboring records on each side.', {
      record_index: { type: 'integer', minimum: 0, description: 'Required exact record_index returned by session.search_history.' },
      surrounding: { type: 'integer', minimum: 0, maximum: 3, description: 'Neighboring records to include on each side. Defaults to 0.' },
    }, ['record_index'], async (args) => {
      const records = transcript(control);
      if (args.record_index >= records.length) {
        throw new ContractError('session_history_record_missing', 'record_index is outside the current conversation history');
      }
      const surrounding = args.surrounding ?? 0;
      const start = Math.max(0, args.record_index - surrounding);
      const end = Math.min(records.length, args.record_index + surrounding + 1);
      const selected = records.slice(start, end).map((record, offset) => projectRecord(record, start + offset, false));
      control.telemetry?.record('session.history_read', 'succeeded', {
        record_index: args.record_index, records_returned: selected.length,
      });
      return output({ records: selected, total_records: records.length }, { records: selected.length });
    });
}

export function searchHistory(records, input) {
  const query = String(input.query ?? '').trim();
  if (!query || query.length > MAX_QUERY) throw new ContractError('session_history_query_invalid', 'history query must contain 1 to 512 characters');
  const limit = Number.isSafeInteger(input.limit) ? input.limit : 8;
  if (limit < 1 || limit > 20) throw new ContractError('session_history_limit_invalid', 'history search limit must be between 1 and 20');
  const types = normalizeTypes(input.types);
  const start = Math.max(0, records.length - MAX_SCAN_RECORDS);
  const terms = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}_.:/-]+/u).filter((term) => term.length > 1))].slice(0, 24);
  const phrase = query.toLowerCase();
  const matches = [];
  for (let index = start; index < records.length; index += 1) {
    const record = records[index];
    const type = String(record?.type ?? 'unknown');
    if (types && !types.has(type)) continue;
    const searchable = searchableText(record).toLowerCase();
    const score = relevance(searchable, phrase, terms);
    if (score <= 0) continue;
    matches.push({ score, index, record });
  }
  matches.sort((left, right) => right.score - left.score || right.index - left.index);
  return Object.freeze({
    query, scanned: records.length - start, truncated: start > 0,
    matches: matches.slice(0, limit).map((item) => ({
      ...projectRecord(item.record, item.index, true), relevance: item.score,
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
      return execute(request.args);
    },
  };
}

function validateArguments(name, args) {
  if (Object.hasOwn(args, 'query') && (typeof args.query !== 'string' || args.query.trim().length < 1 || args.query.length > MAX_QUERY)) invalid(name);
  for (const key of ['limit', 'record_index', 'surrounding']) {
    if (Object.hasOwn(args, key) && !Number.isSafeInteger(args[key])) invalid(name);
  }
  if (Object.hasOwn(args, 'types') && (!Array.isArray(args.types) || args.types.length > 8
    || args.types.some((type) => typeof type !== 'string' || type.length < 1 || type.length > 64))) invalid(name);
}

function transcript(control) {
  const records = control.transcript();
  if (!Array.isArray(records)) throw new ContractError('session_history_unavailable', 'active session history is unavailable');
  return records;
}

function normalizeTypes(value) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > 8) throw new ContractError('session_history_types_invalid', 'history types must contain at most eight record types');
  return new Set(value.map((item) => String(item)));
}

function searchableText(record) {
  if (!record || typeof record !== 'object') return String(record ?? '');
  const values = [record.type, record.role, record.content, record.tool, record.toolName,
    record.target, record.status, record.outcome, record.reason, record.reason_code,
    record.turn_id, record.turnId, record.metadata, record.args, record.arguments];
  return values.map((value) => typeof value === 'string' ? value : safeJson(value)).join('\n').slice(0, 32_768);
}

function relevance(text, phrase, terms) {
  let score = phrase.length > 1 && text.includes(phrase) ? 100 : 0;
  for (const term of terms) {
    let offset = 0; let count = 0;
    while (count < 8 && (offset = text.indexOf(term, offset)) >= 0) { count += 1; offset += term.length; }
    score += count * (term.length >= 8 ? 8 : term.length >= 4 ? 4 : 2);
  }
  return score;
}

function projectRecord(record, index, snippetOnly) {
  const redacted = boundValue(redactExtensionData(record), { remaining: 524_288 }, 0);
  const base = { record_index: index, type: String(record?.type ?? 'unknown') };
  if (!snippetOnly) return { ...base, record: redacted };
  const text = redactText(searchableText(redacted)).replace(/\s+/gu, ' ').trim();
  return { ...base, turn_id: record?.turn_id ?? record?.turnId ?? null, snippet: text.slice(0, MAX_SNIPPET) };
}

function boundValue(value, budget, depth) {
  if (budget.remaining <= 0) return '[truncated:record-budget]';
  if (depth > 12) return '[truncated:depth-limit]';
  if (typeof value === 'string') {
    const text = value.slice(0, Math.min(value.length, budget.remaining));
    budget.remaining -= Buffer.byteLength(text, 'utf8');
    return text.length < value.length ? `${text}[truncated]` : text;
  }
  if (Array.isArray(value)) return value.slice(0, 128).map((item) => boundValue(item, budget, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value).slice(0, 128)) {
    result[key] = boundValue(child, budget, depth + 1);
    if (budget.remaining <= 0) break;
  }
  return result;
}

function output(value, metadata) { return { content: JSON.stringify(value, null, 2), metadata }; }
function safeJson(value) { try { return JSON.stringify(value) ?? ''; } catch { return ''; } }
function invalid(name) { throw new ContractError('tool_schema_invalid', `${name} received invalid arguments`); }
