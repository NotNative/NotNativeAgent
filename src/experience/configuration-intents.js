// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { resolveManifest } from '../config.js';
import { manifestFromConfig } from '../provider/route-configuration.js';

const LIMIT_FIELDS = { providerMs: 'provider_timeout_ms', connectMs: 'provider_connect_timeout_ms',
  semanticReviewMs: 'semantic_review_timeout_ms', approvalMs: 'approval_timeout_ms',
  providerConcurrency: 'provider_concurrency', providerQueueLimit: 'provider_queue_limit', toolConcurrency: 'tool_concurrency' };

export function configurationIntent(kind, input = {}) {
  if (kind === 'limits') return { paths: Object.keys(LIMIT_FIELDS).filter((key) => input[key] !== undefined).map((key) => LIMIT_FIELDS[key]) };
  if (kind === 'bindings') return { paths: ['tui.key_bindings'] };
  if (kind === 'context') return { paths: ['context_limit_bytes', 'context_compaction_threshold', 'context_compression_threshold',
    'context_compression_level_2_threshold', 'context_compression_level_3_threshold'].filter((_, index) => index === 0 || input.values?.[index] !== undefined) };
  if (kind === 'recovery') return { paths: ['recovery.max_model_steps', 'recovery.local_retry_limit', 'recovery.ladder',
    ...(input.includeWallClock ? ['recovery.turn_wall_clock_ms'] : [])] };
  if (kind === 'boolean') return { paths: (input.setting === 'memory.enabled' && !input.value) || (input.setting === 'memory.required' && input.value)
    ? ['memory.enabled', 'memory.required'] : [input.setting] };
  if (kind === 'provider') return { diffRoots: ['providers', 'routes'] };
  if (kind === 'mcp') return { diffRoots: ['mcp_servers'] };
  if (kind === 'route') return routeIntent(input);
  throw new ContractError('configuration_intent_required', 'a typed configuration intent is required');
}

function routeIntent({ role, setting }) {
  if (!['primary', 'reviewer', 'subagent', 'vision'].includes(role)) throw new ContractError('route_role_invalid', 'unknown route role');
  const root = `routes.${role}`;
  if (!setting) return { paths: ['provider_id', 'model', 'context_limit_bytes'].map((key) => `${root}.${key}`) };
  if (setting === 'timeout') return { paths: role === 'primary' ? ['provider_timeout_ms', `${root}.deadline_ms`] : [`${root}.deadline_ms`] };
  const field = { temperature: 'temperature', output: 'max_output_tokens', budget: 'budget', reasoning_effort: 'reasoning_effort', enable_thinking: 'enable_thinking' }[setting];
  if (!field) throw new ContractError('route_setting_invalid', 'unknown route setting');
  return { paths: [`${root}.${field}`] };
}

export function intentChanges(config, next, intent) {
  if (!intent) throw new ContractError('configuration_intent_required', 'a typed configuration intent is required');
  const before = manifestFromConfig(config);
  const canonical = manifestFromConfig(resolveManifest(next));
  const changes = (intent.paths ?? []).map((path) => ({ path, value: at(next, path) }));
  for (const root of intent.diffRoots ?? []) {
    if (root === 'providers' || root === 'mcp_servers') {
      const old = before[root] ?? [], current = canonical[root] ?? [];
      for (const id of new Set([...old, ...current].map((record) => record.id))) {
        const first = old.find((record) => record.id === id), last = current.find((record) => record.id === id);
        if (JSON.stringify(first) !== JSON.stringify(last)) changes.push({ path: root, id, before: first, value: last });
      }
    } else differences(before[root], canonical[root], root, changes);
  }
  return changes;
}

function differences(before, after, path, changes) {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  if (record(before) && record(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) differences(before[key], after[key], `${path}.${key}`, changes);
  } else changes.push({ path, value: after });
}

export function applyIntentChanges(raw, changes) {
  const result = structuredClone(raw);
  for (const change of changes) {
    if (!Object.hasOwn(change, 'id')) { set(result, change.path, change.value); continue; }
    const singular = change.path === 'providers' && result.provider && !result.providers;
    const values = singular ? [{ ...result.provider, id: result.provider.id ?? 'manifest-primary' }] : (result[change.path] ?? []);
    const index = values.findIndex((value) => value.id === change.id);
    if (!change.value) { if (index >= 0) values.splice(index, 1); }
    else if (!change.before) values.push(structuredClone(change.value));
    else {
      if (index < 0) throw new ContractError('configuration_source_required', `edit ${change.path} in its owning source`);
      const edits = []; differences(change.before, change.value, '', edits);
      for (const edit of edits) set(values[index], edit.path.replace(/^\./u, ''), edit.value);
    }
    if (singular && values.length === 1 && values[0].id === (result.provider.id ?? 'manifest-primary')) {
      const hadId = Object.hasOwn(result.provider, 'id'); result.provider = values[0]; if (!hadId) delete result.provider.id;
    } else { result[change.path] = values; if (change.path === 'providers') delete result.provider; }
  }
  return result;
}

export function at(object, path) { return path.split('.').reduce((value, key) => value?.[key], object); }
function set(object, path, value) {
  const keys = path.split('.');
  let cursor = object;
  for (const key of keys.slice(0, -1)) { if (!record(cursor[key])) cursor[key] = {}; cursor = cursor[key]; }
  const key = keys.at(-1);
  if (value === undefined) delete cursor[key]; else cursor[key] = structuredClone(value);
}
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
