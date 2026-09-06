// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { loadWebSearchConfig } from './web-search-config.js';
import { SearxngClient } from './searxng-client.js';
import { normalizeArgumentAliases } from './tools/argument-normalization.js';

export function webSearchDefinition(options) {
  const client = options.client ?? new SearxngClient();
  return {
    name: 'web_search', version: 1,
    purpose: 'Search the web through ordered SearXNG profiles and return bounded source summaries.',
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
      const result = await searchProfiles(client, request.resolved.profiles, request.args, signal);
      validateSearchResult(result);
      const results = result.results.map((item) => resultProjection(item, options.references));
      const response = {
        query: result.query, endpoint: result.endpoint, search_state: result.search_state,
        results, suggestions: result.suggestions ?? [], upstream_failures: result.upstream_failures ?? [],
        used_profile_id: result.used_profile_id, profile_attempts: result.profile_attempts,
      };
      if (result.search_state === 'upstream_degraded') {
        response.recovery_hint = 'Every configured search profile was tried. Retry later or use another source.';
      }
      let content;
      try { content = JSON.stringify(response); }
      catch (error) { throw new ContractError('web_search_response_invalid', 'WebSearch result could not be serialized', { cause: error }); }
      return { content, metadata: {
        endpoint: result.endpoint, result_count: results.length, search_state: result.search_state,
        upstream_failure_count: response.upstream_failures.length, used_profile_id: result.used_profile_id,
        attempted_profile_count: result.profile_attempts.length,
        fallback_used: result.profile_attempts.length > 1,
      } };
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
  if (!config.enabled || config.profiles.length === 0) throw new ContractError('web_search_disabled', 'WebSearch is not configured; use /websearch');
  return {
    args: { ...args, limit: args.limit ?? 8 },
    resolved: { profiles: config.profiles, source: 'global_web_search_profiles' },
  };
}

async function searchProfiles(client, profiles, args, signal) {
  const attempts = []; const valid = []; let lastError;
  // Why: sequential routing preserves the operator's priority and avoids multiplying shared-service traffic.
  for (const item of profiles) {
    try {
      const result = await client.search(item.endpoint, args, signal);
      validateSearchResult(result);
      attempts.push(Object.freeze({
        profile_id: item.id, endpoint: item.endpoint, outcome: result.search_state,
      }));
      valid.push(result);
      if (result.results.length > 0) return combinedResult(result, item.id, attempts, valid);
    } catch (error) {
      if (signal?.aborted || error?.code === 'web_search_cancelled') throw error;
      lastError = error;
      attempts.push(Object.freeze({
        profile_id: item.id, endpoint: item.endpoint, outcome: 'request_failed',
        reason_code: safeReasonCode(error?.code),
      }));
    }
  }
  if (valid.length === 0) {
    throw new ContractError('web_search_profiles_failed', 'Every configured WebSearch profile failed', { cause: lastError });
  }
  const last = valid.at(-1);
  return combinedResult({
    ...last, search_state: attempts.some((item) => item.outcome === 'request_failed'
      || item.outcome === 'upstream_degraded') ? 'upstream_degraded' : 'no_results',
  }, null, attempts, valid);
}

function combinedResult(result, profileId, attempts, valid) {
  const suggestions = [...new Set(valid.flatMap((item) => item.suggestions ?? []))].slice(0, 8);
  const upstreamFailures = valid.flatMap((item) => item.upstream_failures ?? []).slice(0, 16);
  return Object.freeze({
    ...result, suggestions: Object.freeze(suggestions), upstream_failures: Object.freeze(upstreamFailures),
    used_profile_id: profileId, profile_attempts: Object.freeze([...attempts]),
  });
}

function safeReasonCode(value) {
  return typeof value === 'string' && /^[a-z0-9_.-]{1,128}$/u.test(value)
    ? value : 'web_search_request_failed';
}

function validateSearchResult(result) {
  const failures = result?.upstream_failures;
  const profileDegraded = result?.profile_attempts?.some((item) =>
    ['request_failed', 'upstream_degraded'].includes(item?.outcome)) === true;
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || typeof result.endpoint !== 'string' || typeof result.query !== 'string'
    || !Array.isArray(result.results) || result.results.length > 20
    || !['results_returned', 'no_results', 'upstream_degraded'].includes(result.search_state)
    || (result.suggestions !== undefined && !Array.isArray(result.suggestions))
    || (result.profile_attempts !== undefined && (!Array.isArray(result.profile_attempts)
      || result.profile_attempts.length < 1 || result.profile_attempts.length > 8
      || result.profile_attempts.some((item) => !validProfileAttempt(item))))
    || (failures !== undefined && (!Array.isArray(failures) || failures.length > 16
      || failures.some((item) => !validUpstreamFailure(item))))
    || (result.search_state === 'results_returned') !== (result.results.length > 0)
    || (result.search_state === 'upstream_degraded') !== (result.results.length === 0
      && ((failures?.length ?? 0) > 0 || profileDegraded))) {
    throw new ContractError('web_search_response_invalid', 'WebSearch client returned an invalid result');
  }
}

function validProfileAttempt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.profile_id !== 'string' || value.profile_id.length < 1 || value.profile_id.length > 64
    || typeof value.endpoint !== 'string' || value.endpoint.length < 1 || value.endpoint.length > 4096
    || !['results_returned', 'no_results', 'upstream_degraded', 'request_failed'].includes(value.outcome)) return false;
  return value.reason_code === undefined || (value.outcome === 'request_failed'
    && typeof value.reason_code === 'string' && /^[a-z0-9_.-]{1,128}$/u.test(value.reason_code));
}

function validUpstreamFailure(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.engine === 'string' && Array.from(value.engine).length > 0 && Array.from(value.engine).length <= 128
    && typeof value.reason === 'string' && Array.from(value.reason).length > 0 && Array.from(value.reason).length <= 256;
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
  return new ContractError('tool_schema_invalid', 'web_search arguments do not match the schema');
}
