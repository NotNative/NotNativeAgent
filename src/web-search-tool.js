// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { loadWebSearchConfig } from './web-search-config.js';
import { SearxngClient } from './searxng-client.js';
import { normalizeArgumentAliases } from './tools/argument-normalization.js';

export function webSearchDefinition(options) {
  const client = options.client ?? new SearxngClient();
  return {
    name: 'web.search', version: 1,
    purpose: 'Search the web through the user-configured SearXNG service and return bounded source summaries.',
    sideEffect: 'read_only', scope: 'web_search', cancellation: true, timeoutMs: 20_000,
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['query'], properties: {
        query: { type: 'string', minLength: 1, maxLength: 2048, description: 'Required web search query.' },
        categories: { type: 'string', maxLength: 256, description: 'Optional SearXNG category filter.' },
        language: { type: 'string', maxLength: 32, description: 'Optional search language code.' },
        page: { type: 'integer', minimum: 1, maximum: 20, description: 'One-based results page. Defaults to 1.' },
        time_range: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: 'Optional recency filter.' },
        safe_search: { type: 'integer', minimum: 0, maximum: 2, description: 'SearXNG safe-search level: 0 off, 1 moderate, or 2 strict.' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum normalized results to return. Defaults to 8.' },
      },
    },
    normalizeArgs: (args) => normalizeArgumentAliases(args, {
      query: ['q', 'search'], page: ['page_number', 'pageNumber'], time_range: ['recency', 'timeRange'],
      safe_search: ['safeSearch'], limit: ['max_results', 'maxResults'],
    }),
    validate: async (args) => validate(args, options.configPath),
    executor: async (request, signal) => {
      const result = await client.search(request.resolved.endpoint, request.args, signal);
      validateSearchResult(result);
      const results = result.results.map((item) => resultProjection(item, options.references));
      const response = { query: result.query, endpoint: result.endpoint, results, suggestions: result.suggestions ?? [] };
      let content;
      try { content = JSON.stringify(response); }
      catch (error) { throw new ContractError('web_search_response_invalid', 'WebSearch result could not be serialized', { cause: error }); }
      return { content, metadata: { endpoint: result.endpoint, result_count: results.length } };
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
  if (args.time_range !== undefined && !['day', 'week', 'month', 'year'].includes(args.time_range)) throw invalid();
  let config;
  try { config = await loadWebSearchConfig(configPath); }
  catch (error) {
    if (error instanceof ContractError) throw error;
    throw new ContractError('web_search_config_unavailable', 'WebSearch configuration could not be loaded', { cause: error });
  }
  if (!config.enabled || !config.endpoint) throw new ContractError('web_search_disabled', 'WebSearch is not configured; use /websearch');
  return { args: { ...args, limit: args.limit ?? 8 }, resolved: { endpoint: config.endpoint, source: 'global_web_search' } };
}

function validateSearchResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || typeof result.endpoint !== 'string' || typeof result.query !== 'string'
    || !Array.isArray(result.results) || result.results.length > 20
    || (result.suggestions !== undefined && !Array.isArray(result.suggestions))) {
    throw new ContractError('web_search_response_invalid', 'WebSearch client returned an invalid result');
  }
}

function resultProjection(item, references) {
  if (!item || typeof item !== 'object' || typeof item.title !== 'string' || typeof item.url !== 'string') {
    throw new ContractError('web_search_response_invalid', 'WebSearch client returned an invalid result item');
  }
  const projected = {
    title: item.title, url: item.url, content: typeof item.content === 'string' ? item.content : '',
    engine: typeof item.engine === 'string' ? item.engine : undefined,
    score: Number.isFinite(item.score) ? item.score : undefined,
  };
  if (references) {
    try { projected.url_ref = references.remember('url', item.url, 'web_search').id; }
    catch (error) { throw new ContractError('web_search_reference_failed', 'WebSearch URL reference could not be recorded', { cause: error }); }
  }
  return projected;
}

function invalid() {
  return new ContractError('tool_schema_invalid', 'web.search arguments do not match the schema');
}
