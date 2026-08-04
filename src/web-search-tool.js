// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { loadWebSearchConfig } from './web-search-config.js';
import { SearxngClient } from './searxng-client.js';

export function webSearchDefinition(options) {
  const client = options.client ?? new SearxngClient();
  return {
    name: 'web.search', version: 1,
    purpose: 'Search the web through the user-configured SearXNG service and return bounded source summaries. Use this before answering current versions, releases, support status, recent or version-specific technology, news, or event questions. Results locate sources; fetch an authoritative source before making a detailed definitive claim.',
    sideEffect: 'read_only', scope: 'web_search', cancellation: true, timeoutMs: 20_000,
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['query'], properties: {
        query: { type: 'string', minLength: 1, maxLength: 2048 },
        categories: { type: 'string', maxLength: 256 }, language: { type: 'string', maxLength: 32 },
        page: { type: 'integer', minimum: 1, maximum: 20 },
        time_range: { type: 'string', enum: ['day', 'month', 'year'] },
        safe_search: { type: 'integer', minimum: 0, maximum: 2 },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
    },
    validate: async (args) => validate(args, options.configPath),
    executor: async (request, signal) => {
      const result = await client.search(request.resolved.endpoint, request.args, signal);
      return { content: JSON.stringify(result), metadata: { endpoint: result.endpoint, result_count: result.results.length } };
    },
  };
}

async function validate(args, configPath) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw invalid();
  const allowed = new Set(['query', 'categories', 'language', 'page', 'time_range', 'safe_search', 'limit']);
  if (Object.keys(args).some((key) => !allowed.has(key)) || typeof args.query !== 'string'
    || args.query.length < 1 || args.query.length > 2048) throw invalid();
  for (const key of ['categories', 'language']) {
    if (args[key] !== undefined && (typeof args[key] !== 'string' || args[key].length > (key === 'language' ? 32 : 256))) throw invalid();
  }
  if (args.page !== undefined && (!Number.isInteger(args.page) || args.page < 1 || args.page > 20)) throw invalid();
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 20)) throw invalid();
  if (args.safe_search !== undefined && ![0, 1, 2].includes(args.safe_search)) throw invalid();
  if (args.time_range !== undefined && !['day', 'month', 'year'].includes(args.time_range)) throw invalid();
  const config = await loadWebSearchConfig(configPath);
  if (!config.enabled || !config.endpoint) throw new ContractError('web_search_disabled', 'WebSearch is not configured; use /websearch');
  return { args: { ...args, limit: args.limit ?? 8 }, resolved: { endpoint: config.endpoint, source: 'global_web_search' } };
}

function invalid() {
  return new ContractError('tool_schema_invalid', 'web.search arguments do not match the schema');
}
