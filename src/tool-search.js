// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

export function toolSearchDefinition(registry) {
  return {
    name: 'tool.search', version: 1,
    purpose: 'Search the bounded NNA tool catalog for capabilities relevant to the current task.',
    sideEffect: 'read_only', scope: 'tool_catalog', cancellation: true, timeoutMs: 2_000,
    inputSchema: {
      type: 'object', properties: { query: { type: 'string', minLength: 2, maxLength: 512 } },
      required: ['query'], additionalProperties: false,
    },
    validate: async (args) => {
      if (!args || typeof args.query !== 'string' || args.query.trim().length < 2 || args.query.length > 512
        || Object.keys(args).some((key) => key !== 'query')) {
        throw new ContractError('tool_search_invalid', 'tool search requires one bounded query');
      }
      return { args: { query: args.query.trim() }, resolved: { source: 'tool_catalog' } };
    },
    executor: async (request, signal) => {
      if (signal.aborted) throw new ContractError('tool_cancelled', 'tool search was cancelled');
      const matches = registry.search(request.args.query, 12);
      registry.expose(matches.map((item) => item.name));
      return { content: JSON.stringify(matches, null, 2), metadata: { matches: matches.length } };
    },
  };
}

export function rankToolDefinitions(definitions, query, limit) {
  const terms = tokens(query);
  return Object.freeze(definitions.map((item) => ({
    name: item.name, purpose: item.purpose, sideEffect: item.sideEffect, scope: item.scope,
    score: bm25(terms, tokens(`${item.name} ${item.purpose} ${item.scope} ${item.sideEffect}`)),
  })).filter((item) => terms.length === 0 || item.score > 0)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, Math.max(1, Math.min(32, limit))).map((item) => Object.freeze(item)));
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
    const frequency = frequencies.get(term) ?? (document.some((word) => word.includes(term) || term.includes(word)) ? 0.5 : 0);
    return score + (frequency * 2.2) / (frequency + 1.2 * (0.25 + 0.75 * length / 24));
  }, 0);
}
