// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

const literal = (value) => ({ kind: 'literal', value });
const inherited = (source) => ({ kind: 'inherited', source });
const computed = (resolver) => ({ kind: 'computed', resolver });

export const CONFIGURATION_RULES = Object.freeze(Object.fromEntries([
  integer('provider_timeout_ms', 1_800_000, 100, 86_400_000, { zero: 'disabled', dependencies: ['routes.primary.deadline_ms'] }),
  integer('first_token_timeout_ms', 600_000, 100, 86_400_000, { zero: 'disabled', compatibility: 'legacy_stream_timeouts' }),
  integer('idle_timeout_ms', 300_000, 100, 86_400_000, { zero: 'disabled', compatibility: 'legacy_stream_timeouts' }),
  integer('provider_connect_timeout_ms', 10_000, 100, 600_000),
  integer('semantic_review_timeout_ms', inherited('provider_timeout_ms'), 100, 86_400_000, { compatibility: 'legacy_semantic_timeout' }),
  integer('approval_timeout_ms', 120_000, 1_000, 3_600_000),
  integer('provider_concurrency', 1, 1, 16),
  integer('provider_queue_limit', 256, 1, 4096),
  integer('tool_concurrency', 1, 1, 16),
  integer('persistence_flush_timeout_ms', 10_000, 100, 120_000),
  integer('shutdown_timeout_ms', 15_000, 100, 120_000),
  integer('context_limit_bytes', 2_097_152, 65_536, 16_777_216),
  number('context_compression_threshold', 0.40, 0.20, 0.90),
  number('context_compaction_threshold', 0.75, 0.30, 0.99),
  number('context_compression_level_2_threshold', computed('compression_plus_three_sevenths_span'), 0.20, 0.99),
  number('context_compression_level_3_threshold', computed('compression_plus_six_sevenths_span'), 0.20, 0.99),
  integer('recovery.max_model_steps', 1024, 16, 100_000),
  integer('recovery.local_retry_limit', 3, 2, 5),
  integer('recovery.turn_wall_clock_ms', null, 1_000, 86_400_000, { null: 'unset', zero: 'unset' }),
  integer('reviewer_ledger.retention_entries', 10_000, 1, 100_000),
  integer('providers[*].context_limit_bytes', null, 65_536, 16_777_216, { aliases: ['provider.context_limit_bytes'] }),
  integer('providers[*].output_limit_tokens', null, 1, 1_048_576, { aliases: ['provider.output_limit_tokens'] }),
  integer('routes.{role}.context_limit_bytes', null, 65_536, 16_777_216, { dependencies: ['providers[*].context_limit_bytes'] }),
  number('routes.{role}.temperature', null, 0, 2, { null: 'unset', zero: 'value', effectiveZero: 'unset' }),
  integer('routes.{role}.max_output_tokens', null, 1, 1_048_576, { null: 'unset', zero: 'unset' }),
  integer('routes.{role}.budget', null, 1, 64, { null: 'unset', zero: 'unset' }),
  integer('routes.{role}.deadline_ms', null, 100, 86_400_000, { zero: 'value', canonicalZero: true, effectiveZero: 'disabled', dependencies: ['provider_timeout_ms'] }),
  integer('attachments.max_bytes', 10_485_760, 1_024, 104_857_600),
  integer('memory.timeout_ms', 750, 50, 30_000),
  integer('memory.max_items', 8, 1, 64),
  integer('memory.max_bytes', 16_384, 1_024, 262_144),
  integer('mcp_servers[*].timeout_ms', 20_000, 100, 120_000),
  integer('mcp_servers[*].connect_timeout_ms', inherited('mcp_servers[*].timeout_ms'), 100, 120_000),
  integer('mcp_servers[*].list_timeout_ms', inherited('mcp_servers[*].timeout_ms'), 100, 120_000),
  integer('mcp_servers[*].call_timeout_ms', inherited('mcp_servers[*].timeout_ms'), 100, 120_000),
  integer('mcp_servers[*].shutdown_timeout_ms', 2_000, 100, 30_000),
  integer('dream.idle_ms', 45_000, 5_000, 3_600_000),
  integer('dream.inter_stage_ms', 5_000, 1_000, 300_000),
  integer('dream.inference_idle_ms', 120_000, 10_000, 3_600_000),
  integer('dream.hygiene_idle_ms', 300_000, 30_000, 7_200_000),
  integer('dream.retention_days', 30, 1, 365),
  integer('mission.bounds.max_turns', 1, 1, 1_000_000, { classification: 'authority_grant' }),
  integer('mission.bounds.max_tool_calls', 256, 0, 1_000_000, { classification: 'authority_grant' }),
  integer('mission.bounds.max_duration_ms', 3_600_000, 1_000, 604_800_000, { classification: 'authority_grant' }),
].map((rule) => [rule.path, rule])));

function integer(path, fallback, minimum, maximum, options) { return rule(path, 'integer', fallback, minimum, maximum, options); }
function number(path, fallback, minimum, maximum, options) { return rule(path, 'number', fallback, minimum, maximum, options); }
function rule(path, type, fallback, minimum, maximum, options = {}) {
  return Object.freeze({ path, type, minimum, maximum, validator: type === 'integer' ? 'boundedInteger' : 'boundedNumber',
    default: Object.freeze(fallback !== null && typeof fallback === 'object' ? fallback : literal(fallback)),
    unset: Object.freeze({ absent: 'default', null: options.null ?? 'reject', zero: options.zero ?? (minimum <= 0 ? 'value' : 'reject') }),
    classification: options.classification ?? 'operator_setting',
    aliases: Object.freeze(options.aliases ?? []), dependencies: Object.freeze(options.dependencies ?? []),
    ...(options.compatibility ? { compatibility: options.compatibility } : {}),
    ...(options.effectiveZero ? { effectiveZero: options.effectiveZero } : {}),
    ...(options.canonicalZero ? { canonicalZero: true } : {}),
  });
}

export function resolveConfigurationScalar(key, value, ...fallbackOverride) {
  if (!Object.hasOwn(CONFIGURATION_RULES, key)) throw new ContractError('configuration_rule_unknown', 'configuration scalar rule is unavailable');
  const descriptor = CONFIGURATION_RULES[key];
  if (descriptor.unset.null === 'unset' && value === null) return null;
  if (value === 0 && ['unset', 'disabled'].includes(descriptor.unset.zero)) return null;
  if (value === 0 && descriptor.unset.zero === 'value') return descriptor.canonicalZero ? 0 : value;
  const fallback = fallbackOverride.length ? fallbackOverride[0] : descriptor.default.value;
  if (value === undefined && !fallbackOverride.length && descriptor.default.kind !== 'literal') {
    throw new ContractError('configuration_rule_default_required', 'configuration scalar requires its native computed or inherited default');
  }
  return (descriptor.type === 'integer' ? boundedInteger : boundedNumber)(value, fallback, descriptor.minimum, descriptor.maximum);
}

export function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ContractError('invalid_limit', `limit must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export function boundedNumber(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ContractError('invalid_limit', `value must be a number from ${minimum} to ${maximum}`);
  }
  return value;
}
