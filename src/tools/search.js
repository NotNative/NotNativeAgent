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
const WORKFLOW_LEASE_USES = 16;

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
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new ContractError('tool_search_invalid', 'tool search arguments must be an object containing query');
      }
      const unknown = Object.keys(args).find((key) => key !== 'query');
      if (unknown) throw new ContractError('tool_search_invalid', `unknown tool search argument "${unknown}"; allowed argument: query`);
      if (typeof args.query !== 'string') throw new ContractError('tool_search_invalid', 'tool search query must be a string');
      const query = args.query.trim();
      const length = [...query].length;
      if (length < 2) throw new ContractError('tool_search_invalid', `tool search query must contain at least 2 non-whitespace characters; received ${length}`);
      if (length > MAX_QUERY_CHARACTERS) {
        throw new ContractError('tool_search_invalid', `tool search query must contain at most ${MAX_QUERY_CHARACTERS} characters; received ${length}`);
      }
      return { args: { query }, resolved: { source: 'tool_catalog' } };
    },
    executor: async (request, signal) => {
      if (signal.aborted) throw new ContractError('tool_cancelled', 'tool search was cancelled');
      const matches = registry.searchCatalog(request.args.query, DEFAULT_SEARCH_RESULTS);
      const named = exactRequestedName(request.args.query, matches);
      const visibleMatches = matches.filter((item) => item.scope !== 'external'
        || explicitlyRequestsExternal(request.args.query, item));
      // Why: ranked neighbors are discovery suggestions, not an unambiguous request to alter
      // the next provider schema. Only an exact catalog name creates a predictable lease.
      const lease = named
        ? registry.grantWorkflowLease([named], { uses: WORKFLOW_LEASE_USES, source: 'tool.search' })
        : { granted: [], rejected: [] };
      const schema = named ? registry.definition(named)?.inputSchema : null;
      const loaded = lease.granted.length > 0;
      const rejected = lease.rejected.length > 0;
      return {
        content: JSON.stringify({
          status: loaded ? 'schema_loaded_for_next_model_step'
            : rejected ? 'schema_load_rejected'
              : visibleMatches.length > 0 ? 'catalog_matches_found' : 'no_relevant_capability_found',
          instruction: loaded
            ? 'Call the exact matching tool directly. Its schema is guaranteed for this bounded workflow lease.'
            : rejected ? 'The exact schema could not fit the bounded provider surface. Use an already visible capability or end with an honest typed blocker.'
              : visibleMatches.length > 0 ? 'These are discovery suggestions only. Search once using the exact tool name to load one schema.'
                : 'No relevant catalog capability matched. Continue with already visible tools or refine once using an exact tool or service name; do not repeat this search unchanged.',
          matches: visibleMatches.map(compactMatch),
          lease,
          ...(named && schema ? { exact_match: { name: named, input_schema: schema } } : {}),
        }, null, 2),
        metadata: { matches: visibleMatches.length, exposed: lease.granted.map((item) => item.name), exactMatch: named,
          leaseRejected: lease.rejected.map((item) => item.reason) },
      };
    },
  };
}

function explicitlyRequestsExternal(query, item) {
  const queryTerms = new Set(tokens(query));
  if (queryTerms.has('mcp') || queryTerms.has('external')) return true;
  const identityTerms = tokens(item.name.replace(/^mcp[._-]/u, ''));
  return identityTerms.some((term) => term.length >= 4 && queryTerms.has(term));
}

function compactMatch(item) {
  const purpose = String(item.purpose ?? '').trim().replace(/\s+/gu, ' ');
  const sentence = purpose.match(/^.*?[.!?](?:\s|$)/u)?.[0]?.trim() ?? purpose;
  return {
    ...item,
    purpose: sentence.length <= 240 ? sentence : `${sentence.slice(0, 239)}…`,
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
