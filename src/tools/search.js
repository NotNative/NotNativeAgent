// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';

const SEARCH_TIMEOUT_MS = 2_000;
const DEFAULT_SEARCH_RESULTS = 12;
const MAX_SEARCH_RESULTS = 32;
const MAX_QUERY_CHARACTERS = 512;
const BM25_TERM_SATURATION = 2.2;
const BM25_LENGTH_SENSITIVITY = 1.2;
const BM25_MIN_NORMALIZATION = 0.25;
const BM25_LENGTH_WEIGHT = 0.75;
const BM25_REFERENCE_LENGTH = 24;

export function toolSearchDefinition(registry) {
  return {
    name: 'tool.search', version: 1,
    purpose: 'Search the bounded NNA tool catalog for capabilities relevant to the current task.',
    sideEffect: 'read_only', scope: 'tool_catalog', cancellation: true, timeoutMs: SEARCH_TIMEOUT_MS,
    inputSchema: {
      type: 'object', properties: {
        query: { type: 'string', minLength: 2, maxLength: MAX_QUERY_CHARACTERS, description: 'Required capability description, such as search session history or inspect Git changes.' },
      },
      required: ['query'], additionalProperties: false,
    },
    validate: async (args) => {
      if (!args || typeof args.query !== 'string'
        || args.query.trim().length < 2 || args.query.length > MAX_QUERY_CHARACTERS
        || Object.keys(args).some((key) => key !== 'query')) {
        throw new ContractError('tool_search_invalid', 'tool search requires one bounded query');
      }
      return { args: { query: args.query.trim() }, resolved: { source: 'tool_catalog' } };
    },
    executor: async (request, signal) => {
      if (signal.aborted) throw new ContractError('tool_cancelled', 'tool search was cancelled');
      const matches = registry.searchCatalog(request.args.query, DEFAULT_SEARCH_RESULTS);
      registry.expose(matches.map((item) => item.name));
      const named = exactRequestedName(request.args.query, matches);
      const schema = named ? registry.definition(named)?.inputSchema : null;
      return {
        content: JSON.stringify({
          status: 'schemas_loaded_for_next_model_step',
          instruction: 'Call the matching tool directly on the next model step. Do not search for the same tool again.',
          matches,
          ...(named && schema ? { exact_match: { name: named, input_schema: schema } } : {}),
        }, null, 2),
        metadata: { matches: matches.length, exposed: matches.map((item) => item.name), exactMatch: named },
      };
    },
  };
}

function exactRequestedName(query, matches) {
  const text = String(query).toLowerCase();
  return matches.find((item) => new RegExp(`(?:^|[^a-z0-9_.-])${escapePattern(item.name.toLowerCase())}(?:$|[^a-z0-9_.-])`, 'u').test(text))?.name ?? null;
}

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function rankToolDefinitions(definitions, query, limit) {
  const terms = tokens(query);
  const effectiveLimit = Number.isSafeInteger(limit)
    ? Math.max(1, Math.min(MAX_SEARCH_RESULTS, limit)) : DEFAULT_SEARCH_RESULTS;
  return Object.freeze(definitions.map((item) => ({
    name: item.name, purpose: item.purpose, sideEffect: item.sideEffect, scope: item.scope,
    score: bm25(terms, tokens(`${item.name} ${item.purpose} ${item.scope} ${item.sideEffect}`)),
  })).filter((item) => terms.length === 0 || item.score > 0)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, effectiveLimit).map((item) => Object.freeze(item)));
}

function tokens(value) {
  return [...new Set(String(value).toLowerCase().match(/[a-z0-9_.-]{2,}/gu) ?? [])];
}

function bm25(query, document) {
  if (query.length === 0) return 0;
  const frequencies = new Map();
  for (const term of document) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  const length = Math.max(1, document.length);
  return query.reduce((score, term) => {
    const frequency = frequencies.get(term) ?? 0;
    const normalization = BM25_MIN_NORMALIZATION
      + (BM25_LENGTH_WEIGHT * length / BM25_REFERENCE_LENGTH);
    return score + (frequency * BM25_TERM_SATURATION)
      / (frequency + BM25_LENGTH_SENSITIVITY * normalization);
  }, 0);
}
